import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import path from "node:path";
import crypto from "node:crypto";
import { Database } from "./db.js";
import type { Config } from "./config.js";
import { Projects } from "./projects.js";
import { Support } from "./support.js";
import {
  AppError,
  equal,
  issueSession,
  verifySession,
  sign,
  unseal,
  type Session,
} from "./security.js";
import type { Project } from "./model.js";
type Req = Request & { rawBody?: string; project?: Project; session?: Session };
const uuid = z.string().uuid(),
  keySchema = z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9:_-]+$/);
const asyncRoute =
  (fn: (req: Req, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
export function createApp(db: Database, config: Config) {
  const app = express(),
    projects = new Projects(db, config),
    support = new Support(db, projects);
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(
    helmet({
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
    }),
  );
  app.use(
    express.json({
      limit: "64kb",
      verify: (req, _res, buf) => {
        (req as Req).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.get(
    "/health",
    asyncRoute(async (_req, res) => {
      await db.query("SELECT 1");
      res.json({ ok: true });
    }),
  );
  app.use(
    "/support",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  app.use("/support", (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(async () => {
        const origin = req.header("origin");
        if (origin && origin !== new URL(config.PUBLIC_URL).origin) {
          const permitted = await db.one(
            "SELECT id FROM projects WHERE enabled=true AND settings->'origins' ? $1 LIMIT 1",
            [origin],
          );
          if (!permitted) throw new AppError(403, "来源网站未授权");
          res
            .set("Access-Control-Allow-Origin", origin)
            .set("Vary", "Origin")
            .set(
              "Access-Control-Allow-Headers",
              "Authorization, Content-Type, X-Embed-Origin, Idempotency-Key",
            )
            .set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
        if (req.method === "OPTIONS") res.status(204).end();
        else next();
      })
      .catch(next);
  });
  const admin = (req: Request, res: Response, next: NextFunction) => {
    if (
      !equal(
        (req.header("authorization") || "").replace(/^Bearer /, ""),
        config.ADMIN_TOKEN,
      )
    )
      return res.status(401).json({ error: "管理令牌错误" });
    next();
  };
  app.use(
    "/admin/api",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
    admin,
  );
  app.get(
    "/admin/api/projects",
    asyncRoute(async (_req, res) => {
      const rows = (
        await db.query("SELECT * FROM projects ORDER BY created_at")
      ).rows;
      res.json(rows.map((r) => projects.admin(projects.decode(r))));
    }),
  );
  app.post(
    "/admin/api/projects",
    asyncRoute(async (req, res) => res.json(await projects.save(req.body))),
  );
  app.put(
    "/admin/api/projects/:id",
    asyncRoute(async (req, res) =>
      res.json(await projects.save(req.body, uuid.parse(req.params.id))),
    ),
  );
  app.post(
    "/admin/api/projects/:id/test",
    asyncRoute(async (req, res) =>
      res.json(await projects.test(uuid.parse(req.params.id))),
    ),
  );
  app.post(
    "/admin/api/projects/:id/connect",
    asyncRoute(async (req, res) =>
      res.json(await projects.connect(uuid.parse(req.params.id))),
    ),
  );
  app.post(
    "/admin/api/projects/:id/rotate",
    asyncRoute(async (req, res) =>
      res.json(await projects.rotate(uuid.parse(req.params.id))),
    ),
  );
  const bootstrap = (
    p: Project,
    identity: {
      externalUserId: string;
      name?: string;
      email: string;
      origin: string;
    },
  ) => {
    if (
      !p.settings.origins.includes(identity.origin) &&
      identity.origin !== new URL(config.PUBLIC_URL).origin
    )
      throw new AppError(403, "网站未在项目允许域名中");
    const s: Session = {
      pid: p.id,
      uid: identity.externalUserId,
      name: identity.name || "",
      email: identity.email,
      origin: identity.origin,
      version: p.version,
    };
    return {
      project: projects.public(p),
      session: { token: issueSession(s, config), expiresIn: 900 },
      embedOrigin: identity.origin,
      publicUrl: config.PUBLIC_URL,
      features: { aiChat: true, tickets: true },
      welcomeMessage: p.settings.welcome,
      presetQuestions: p.settings.questions.filter((q) => q.enabled),
      ticketCategories: p.settings.categories,
      configVersion: p.version,
    };
  };
  app.post(
    "/admin/api/projects/:id/preview",
    asyncRoute(async (req, res) => {
      const p = await projects.get(uuid.parse(req.params.id));
      if (!p.enabled) throw new AppError(400, "请先连接机器人并启用项目");
      res.json(
        bootstrap(p, {
          externalUserId: "__admin_preview__",
          name: "项目预览",
          email: "preview@example.invalid",
          origin: new URL(config.PUBLIC_URL).origin,
        }),
      );
    }),
  );
  app.get(
    "/admin/api/jobs",
    asyncRoute(async (_req, res) =>
      res.json(
        (
          await db.query(
            "SELECT j.id,j.state,j.attempts,j.error,j.updated_at,p.name AS project FROM ai_jobs j JOIN projects p ON p.id=j.project_id ORDER BY j.updated_at DESC LIMIT 100",
          )
        ).rows,
      ),
    ),
  );
  app.post(
    "/admin/api/jobs/:id/retry",
    asyncRoute(async (req, res) => {
      const r = await db.query(
        "UPDATE ai_jobs SET state='pending',attempts=0,next_at=now() WHERE id=$1 AND state='failed' RETURNING id",
        [uuid.parse(req.params.id)],
      );
      if (!r.rowCount) throw new AppError(409, "该任务当前不可重试");
      res.json({ ok: true });
    }),
  );
  const signed = async (req: Req) => {
    const apiKey = req.header("x-support-key") || "",
      time = req.header("x-support-timestamp") || "",
      nonce = req.header("x-support-nonce") || "";
    if (
      !/^\d{10}$/.test(time) ||
      Math.abs(Date.now() / 1000 - Number(time)) > 300 ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)
    )
      throw new AppError(401, "项目签名过期或无效");
    const row = await db.one(
      "SELECT * FROM projects WHERE api_key=$1 AND enabled=true",
      [apiKey],
    );
    if (!row) throw new AppError(401, "项目凭证无效");
    const p = projects.decode(row),
      expected = sign(
        req.method,
        req.originalUrl,
        time,
        nonce,
        req.rawBody || "",
        unseal(p.api_secret, config.MASTER_KEY),
      );
    if (!equal(expected, req.header("x-support-signature") || ""))
      throw new AppError(401, "项目签名无效");
    const inserted = await db.query(
      "INSERT INTO nonces(project_id,nonce,expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT DO NOTHING",
      [p.id, nonce],
    );
    if (!inserted.rowCount) throw new AppError(401, "请求已使用");
    await db.query("DELETE FROM nonces WHERE expires_at<now()");
    if (req.body.projectCode !== p.code)
      throw new AppError(403, "项目编码与凭证不匹配");
    return p;
  };
  app.post(
    "/support/v1/check",
    asyncRoute(async (req, res) =>
      res.json({ project: projects.public(await signed(req)), ok: true }),
    ),
  );
  app.post(
    "/support/v1/bootstrap",
    asyncRoute(async (req, res) => {
      const p = await signed(req);
      const identity = z
        .object({
          externalUserId: z.string().min(1).max(150),
          name: z.string().max(100).optional(),
          email: z.string().email().max(200),
          origin: z.string().url(),
        })
        .parse(req.body);
      res.json(bootstrap(p, identity));
    }),
  );
  // Compose async middleware with explicit next(), keeping route handlers terminal.
  const sessionMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    Promise.resolve()
      .then(async () => {
        const r = req as Req;
        r.session = verifySession(
          (req.header("authorization") || "").replace(/^Bearer /, ""),
          config,
        );
        r.project = await projects.get(r.session.pid);
        if (!r.project.enabled || r.project.version !== r.session.version)
          throw new AppError(
            401,
            "客服配置已更新，请重新连接",
            "SESSION_EXPIRED",
          );
        if (req.header("x-embed-origin") !== r.session.origin)
          throw new AppError(403, "会话来源不匹配");
        const o = req.header("origin");
        if (
          o &&
          o !== new URL(config.PUBLIC_URL).origin &&
          o !== r.session.origin
        )
          throw new AppError(403, "会话来源不匹配");
      })
      .then(() => next(), next);
  };
  app.use("/support/v1/session", sessionMiddleware);
  app.get(
    "/support/v1/session",
    asyncRoute(async (req, res) =>
      res.json({ project: projects.public(req.project!) }),
    ),
  );
  app.use(
    ["/support/v1/conversations", "/support/v1/tickets"],
    sessionMiddleware,
  );
  app.get(
    "/support/v1/conversations",
    asyncRoute(async (req, res) =>
      res.json(
        await support.list(
          req.project!,
          req.session!,
          false,
          req.query.before ? uuid.parse(req.query.before) : undefined,
        ),
      ),
    ),
  );
  app.post(
    "/support/v1/conversations",
    asyncRoute(async (req, res) =>
      res.json(
        await support.create(
          req.project!,
          req.session!,
          keySchema.parse(req.header("idempotency-key")),
        ),
      ),
    ),
  );
  app.get(
    "/support/v1/conversations/:id/messages",
    asyncRoute(async (req, res) =>
      res.json(
        await support.messages(
          req.project!,
          req.session!,
          uuid.parse(req.params.id),
          req.query.before
            ? z.coerce.number().int().positive().parse(req.query.before)
            : undefined,
        ),
      ),
    ),
  );
  app.post(
    "/support/v1/conversations/:id/messages",
    asyncRoute(async (req, res) => {
      const { content } = z
        .object({ content: z.string().trim().min(1).max(8000) })
        .parse(req.body);
      res
        .status(202)
        .json(
          await support.send(
            req.project!,
            req.session!,
            uuid.parse(req.params.id),
            content,
            keySchema.parse(req.header("idempotency-key")),
          ),
        );
    }),
  );
  app.get(
    "/support/v1/tickets",
    asyncRoute(async (req, res) =>
      res.json(
        await support.list(
          req.project!,
          req.session!,
          true,
          req.query.before ? uuid.parse(req.query.before) : undefined,
        ),
      ),
    ),
  );
  app.get(
    "/support/v1/tickets/:id",
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const conversation = await support.owned(req.session!, id);
      if (!conversation.ticket) throw new AppError(404, "工单不存在");
      res.json(
        await support.messages(
          req.project!,
          req.session!,
          id,
          req.query.before
            ? z.coerce.number().int().positive().parse(req.query.before)
            : undefined,
        ),
      );
    }),
  );
  app.post(
    "/support/v1/tickets",
    asyncRoute(async (req, res) => {
      const b = z
        .object({
          conversationId: uuid,
          category: z.string().max(50),
          description: z.string().trim().min(1).max(8000),
        })
        .parse(req.body);
      res.json(
        await support.ticket(
          req.project!,
          req.session!,
          b.conversationId,
          b.category,
          b.description,
          keySchema.parse(req.header("idempotency-key")),
        ),
      );
    }),
  );
  app.post(
    "/hooks/chatwoot/:pid/:secret",
    rateLimit({
      windowMs: 60000,
      limit: 600,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
    asyncRoute(async (req, res) => {
      const p = await projects.get(uuid.parse(req.params.pid));
      if (
        !equal(
          String(req.params.secret),
          unseal(p.hook_secret, config.MASTER_KEY),
        )
      )
        throw new AppError(401, "回调认证失败");
      const time = req.header("x-chatwoot-timestamp") || "";
      if (
        !p.cw_hook_secret ||
        !/^\d{10}$/.test(time) ||
        Math.abs(Date.now() / 1000 - Number(time)) > 300
      )
        throw new AppError(401, "回调签名已过期或未配置");
      const signature =
        "sha256=" +
        crypto
          .createHmac("sha256", unseal(p.cw_hook_secret, config.MASTER_KEY))
          .update(time + "." + (req.rawBody || ""))
          .digest("hex");
      if (!equal(signature, req.header("x-chatwoot-signature") || ""))
        throw new AppError(401, "回调签名无效");
      await support.hook(p, req.body);
      res.json({ ok: true });
    }),
  );
  app.get(
    "/widget",
    asyncRoute(async (req, res) => {
      const code = z.string().max(50).parse(req.query.project),
        row = await db.one("SELECT * FROM projects WHERE code=$1", [code]);
      if (!row) throw new AppError(404, "项目不存在");
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self' " +
          projects.decode(row).settings.origins.join(" "),
      );
      res.set("Cache-Control", "no-store");
      res.sendFile(path.resolve("dist/web/index.html"));
    }),
  );
  app.use(express.static(path.resolve("dist/web"), { index: false }));
  app.get(["/", "/admin"], (_req, res) =>
    res.sendFile(path.resolve("dist/web/index.html")),
  );
  app.use((_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof z.ZodError
        ? 400
        : err instanceof AppError
          ? err.status
          : err.code === "23505"
            ? 409
            : 500;
    if (status === 500) console.error("Support error:", err.name || "Error");
    res.status(status).json({
      error:
        err instanceof z.ZodError
          ? "参数错误：" +
            err.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")
          : err instanceof AppError
            ? err.message
            : status === 409
              ? "记录已存在"
              : "服务暂时不可用",
      code: err.code || "REQUEST_FAILED",
    });
  });
  return { app, projects, support };
}
