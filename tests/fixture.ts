import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { Database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createApp } from "../src/app.js";
import { Worker } from "../src/worker.js";
import { unseal, sign } from "../src/security.js";
import type { Config } from "../src/config.js";
export const testAdmin = "test-admin-token-for-isolated-support-tests-only";
export async function listen(app: ReturnType<typeof express>, port = 0) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
}
export const close = (s: Server) =>
  new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  });
export async function fixture(port = 0) {
  const url =
    process.env.TEST_DATABASE_URL ||
    "postgresql://support_test:local-support-tests-only@127.0.0.1:55439/support_test";
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("Tests require a dedicated database ending with _test");
  const db = new Database(url);
  await migrate(db);
  await db.query("TRUNCATE projects CASCADE");
  let next = 1;
  const contacts: any[] = [],
    conversations: any[] = [],
    bots = new Map<number, string>(),
    maxkbCalls: any[] = [];
  let release: (() => void) | undefined;
  let delayed = false;
  const definitions: any[] = [];
  const mock = express();
  mock.use(express.json());
  const prefix = "/api/v1/accounts/:account";
  mock.get(prefix + "/custom_attribute_definitions", (req, res) =>
    res.json(
      definitions.filter((d) => d.account === Number(req.params.account)),
    ),
  );
  mock.post(prefix + "/custom_attribute_definitions", (req, res) => {
    const d = {
      id: next++,
      account: Number(req.params.account),
      ...req.body.custom_attribute_definition,
    };
    definitions.push(d);
    res.json(d);
  });
  mock.use("/api/v1/accounts/:account", (req, res, next) =>
    req.header("api_access_token") === "cw-" + req.params.account
      ? next()
      : res.status(401).json({ error: "token" }),
  );
  mock.get(prefix + "/inboxes/:inbox", (req, res) =>
    res.json({
      id: Number(req.params.inbox),
      channel_type: "Channel::Api",
      name: "Test API",
    }),
  );
  mock.post(prefix + "/agent_bots", (req, res) => {
    bots.set(Number(req.params.account), req.body.outgoing_url);
    res.json({ id: Number(req.params.account) });
  });
  mock.get(prefix + "/agent_bots/:id", (req, res) =>
    res.json({
      id: Number(req.params.id),
      secret: "mock-hook-secret-" + req.params.account,
    }),
  );
  mock.patch(prefix + "/agent_bots/:id", (req, res) => {
    bots.set(Number(req.params.account), req.body.outgoing_url);
    res.json({ id: Number(req.params.id) });
  });
  mock.post(prefix + "/inboxes/:id/set_agent_bot", (_req, res) =>
    res.status(200).end(),
  );
  mock.get(prefix + "/contacts/search", (req, res) =>
    res.json({
      payload: contacts.filter(
        (x) =>
          x.account === Number(req.params.account) &&
          x.identifier === req.query.q,
      ),
    }),
  );
  mock.post(prefix + "/contacts", (req, res) => {
    const c = {
      id: next++,
      account: Number(req.params.account),
      ...req.body,
      contact_inboxes: [
        { source_id: req.body.source_id, inbox: { id: req.body.inbox_id } },
      ],
    };
    contacts.push(c);
    res.json({ payload: { contact: c } });
  });
  mock.get(prefix + "/contacts/:id", (req, res) =>
    res.json({
      payload: contacts.find(
        (x) =>
          x.id === Number(req.params.id) &&
          x.account === Number(req.params.account),
      ),
    }),
  );
  mock.get(prefix + "/contacts/:id/conversations", (req, res) =>
    res.json({
      payload: conversations.filter(
        (x) =>
          x.contact_id === Number(req.params.id) &&
          x.account === Number(req.params.account),
      ),
    }),
  );
  mock.post(prefix + "/conversations", (req, res) => {
    const c = {
      id: next++,
      account: Number(req.params.account),
      ...req.body,
      custom_attributes: {},
      messages: [],
    };
    conversations.push(c);
    res.json(c);
  });
  const find = (req: any) =>
    conversations.find(
      (c) =>
        c.id === Number(req.params.id) &&
        c.account === Number(req.params.account),
    );
  mock.get(prefix + "/conversations/:id", (req, res) => {
    const c = find(req);
    if (!c) return res.status(404).json({ error: "missing" });
    res.json(c);
  });
  mock.post(prefix + "/conversations/:id/custom_attributes", (req, res) => {
    const c = find(req);
    c.custom_attributes = req.body.custom_attributes;
    res.json(c);
  });
  mock.post(prefix + "/conversations/:id/toggle_status", (req, res) => {
    const c = find(req);
    c.status = req.body.status;
    res.json({ payload: { success: true } });
  });
  mock.get(prefix + "/conversations/:id/messages", (req, res) => {
    const c = find(req);
    if (!c) return res.status(404).json({ error: "missing" });
    res.json({
      payload: c.messages
        .filter(
          (m: any) => !req.query.before || m.id < Number(req.query.before),
        )
        .slice(-20),
    });
  });
  mock.post(prefix + "/conversations/:id/messages", (req, res) => {
    const c = find(req);
    if (!c) return res.status(404).json({ error: "missing" });
    const message = {
      ...req.body,
      id: next++,
      created_at: Math.floor(Date.now() / 1000),
      sender: { id: c.contact_id },
      message_type: req.body.message_type === "incoming" ? 0 : 1,
    };
    c.messages.push(message);
    res.json(message);
    const hook = bots.get(c.account);
    if (hook)
      setTimeout(() => {
        const body = JSON.stringify({
            ...message,
            event: "message_created",
            account: { id: c.account },
            conversation: { id: c.id },
          }),
          time = String(Math.floor(Date.now() / 1000));
        const signature =
          "sha256=" +
          crypto
            .createHmac("sha256", "mock-hook-secret-" + c.account)
            .update(time + "." + body)
            .digest("hex");
        void fetch(hook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Chatwoot-Timestamp": time,
            "X-Chatwoot-Signature": signature,
          },
          body,
        }).catch(() => undefined);
      }, 10);
  });
  mock.post("/maxkb/:project/chat/completions", async (req, res) => {
    maxkbCalls.push({ project: req.params.project, ...req.body });
    const last = req.body.messages.at(-1).content;
    if (last === "NO_ANSWER")
      return res.status(503).json({ error: "unavailable" });
    if (last === "DELAY") {
      delayed = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "知识库(" +
              req.params.project +
              ")：" +
              last +
              "。这是知识库回答。",
          },
        },
      ],
    });
  });
  const upstream = await listen(mock),
    upstreamUrl = "http://127.0.0.1:" + (upstream.address() as any).port;
  const config: Config = {
    DATABASE_URL: url,
    MASTER_KEY: "ab".repeat(32),
    ADMIN_TOKEN: testAdmin,
    PUBLIC_URL: "http://127.0.0.1:" + port,
    PORT: port,
    TRUST_PROXY_HOPS: 0,
    ALLOW_HTTP_UPSTREAMS: "true",
    AI_TIMEOUT_MS: 10000,
    WORKER_CONCURRENCY: 1,
  };
  const { app, projects, support } = createApp(db, config);
  const server = await listen(app, port);
  config.PUBLIC_URL = "http://127.0.0.1:" + (server.address() as any).port;
  const make = async (code: string, account: number) => {
    const p = await projects.save({
      code,
      name: "测试项目 " + code,
      enabled: false,
      settings: {
        chatwootUrl: upstreamUrl,
        chatwootToken: "cw-" + account,
        accountId: account,
        inboxId: account,
        maxkbUrl: upstreamUrl + "/maxkb/" + code,
        maxkbKey: "mk-" + code,
        model: "maxkb",
        origins: ["https://website.test"],
        questions: [
          { id: "key", question: "API Key 在哪里创建？", enabled: true },
        ],
        categories: [{ code: "technical", name: "技术问题" }],
      },
    });
    await projects.connect(p.id);
    const connected = await projects.get(p.id);
    await projects.save({ ...connected, enabled: true }, p.id);
    return projects.get(p.id);
  };
  const project = await make("letaicode", 1),
    other = await make("other", 2),
    worker = new Worker(db, projects);
  const bootstrap = async (p = project, uid = "user-1") => {
    const body = JSON.stringify({
      projectCode: p.code,
      externalUserId: uid,
      email: uid + "@example.com",
      name: uid,
      origin: "https://website.test",
    });
    const time = String(Math.floor(Date.now() / 1000)),
      nonce = crypto.randomBytes(20).toString("hex"),
      path = "/support/v1/bootstrap";
    const headers = {
      "Content-Type": "application/json",
      "X-Support-Key": p.api_key,
      "X-Support-Timestamp": time,
      "X-Support-Nonce": nonce,
      "X-Support-Signature": sign(
        "POST",
        path,
        time,
        nonce,
        body,
        unseal(p.api_secret, config.MASTER_KEY),
      ),
    };
    const r = await fetch(config.PUBLIC_URL + path, {
      method: "POST",
      headers,
      body,
    });
    return { data: await r.json(), headers, body, path };
  };
  return {
    db,
    config,
    project,
    other,
    projects,
    support,
    server,
    upstream,
    conversations,
    contacts,
    maxkbCalls,
    worker,
    bootstrap,
    delayed: () => delayed,
    release: () => release?.(),
    close: async () => {
      release?.();
      await worker.close();
      await close(server);
      await close(upstream);
      await db.close();
    },
  };
}
export async function waitFor(fn: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Timed out waiting for test state");
}
