import crypto from "node:crypto";
import { Database } from "./db.js";
import type { Config } from "./config.js";
import { projectSchema, type Project, type Settings } from "./model.js";
import { AppError, seal, unseal, validateUrl } from "./security.js";
import { Chatwoot } from "./providers.js";
import { sampleQuestions } from "./presets.js";
export class Projects {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}
  decode(row: any): Project {
    const s = { ...row.settings };
    for (const key of ["chatwootToken", "maxkbKey"])
      s[key] = unseal(s[key], this.config.MASTER_KEY);
    return { ...row, settings: s };
  }
  async get(id: string) {
    const row = await this.db.one("SELECT * FROM projects WHERE id=$1", [id]);
    if (!row) throw new AppError(404, "项目不存在");
    return this.decode(row);
  }
  public(p: Project) {
    return {
      code: p.code,
      name: p.name,
      welcome: p.settings.welcome,
      color: p.settings.color,
      questions: sampleQuestions(p.settings.questions),
      categories: p.settings.categories,
      configVersion: p.version,
    };
  }
  admin(p: Project) {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      enabled: p.enabled,
      version: p.version,
      apiKey: p.api_key,
      settings: { ...p.settings, chatwootToken: "", maxkbKey: "" },
      credentialsConfigured: true,
    };
  }
  async save(input: unknown, id?: string) {
    const previous = id ? await this.get(id) : undefined;
    const raw = input as any;
    if (previous)
      raw.settings = {
        ...raw.settings,
        chatwootToken:
          raw.settings?.chatwootToken || previous.settings.chatwootToken,
        maxkbKey: raw.settings?.maxkbKey || previous.settings.maxkbKey,
      };
    const v = projectSchema.parse(raw);
    if (previous && previous.code !== v.code)
      throw new AppError(400, "项目编码创建后不可更改");
    if (v.enabled && (!v.settings.botId || !previous?.cw_hook_secret))
      throw new AppError(400, "请先保存未启用项目并连接 AI 机器人，再启用项目");
    v.settings.chatwootUrl = validateUrl(v.settings.chatwootUrl, this.config);
    v.settings.maxkbUrl = validateUrl(v.settings.maxkbUrl, this.config);
    if (
      new Set(v.settings.categories.map((x) => x.code)).size !==
        v.settings.categories.length ||
      new Set(v.settings.questions.map((x) => x.id)).size !==
        v.settings.questions.length
    )
      throw new AppError(400, "分类编码或问题 ID 重复");
    const same = await this.db.one(
      "SELECT id FROM projects WHERE settings->>'chatwootUrl'=$1 AND settings->>'accountId'=$2 AND id<>$3",
      [
        v.settings.chatwootUrl,
        String(v.settings.accountId),
        id || "00000000-0000-0000-0000-000000000000",
      ],
    );
    if (same)
      throw new AppError(
        409,
        "为保障项目隔离，每个项目应使用独立 Chatwoot Account",
      );
    if (
      previous &&
      ["chatwootUrl", "accountId", "inboxId"].some(
        (k) => (previous.settings as any)[k] !== (v.settings as any)[k],
      )
    ) {
      if (
        await this.db.one(
          "SELECT id FROM conversations WHERE project_id=$1 LIMIT 1",
          [id],
        )
      )
        throw new AppError(
          409,
          "已有会话的项目不能更换 Chatwoot 绑定，请新建项目",
        );
    }
    const settings = { ...v.settings };
    for (const key of ["chatwootToken", "maxkbKey"] as const)
      settings[key] = seal(settings[key], this.config.MASTER_KEY);
    const secret = crypto.randomBytes(32).toString("hex"),
      hookSecret = crypto.randomBytes(32).toString("hex");
    const pid = id || crypto.randomUUID();
    if (previous)
      await this.db.query(
        "UPDATE projects SET name=$2,enabled=$3,settings=$4,version=version+1 WHERE id=$1",
        [pid, v.name, v.enabled, settings],
      );
    else
      await this.db.query(
        "INSERT INTO projects(id,code,name,enabled,api_key,api_secret,hook_secret,settings) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          pid,
          v.code,
          v.name,
          v.enabled,
          "sh_" + crypto.randomBytes(20).toString("hex"),
          seal(secret, this.config.MASTER_KEY),
          seal(hookSecret, this.config.MASTER_KEY),
          settings,
        ],
      );
    const p = await this.get(pid);
    return {
      ...this.admin(p),
      ...(previous ? {} : { apiSecret: secret }),
      hookUrl: this.hookUrl(p),
    };
  }
  hookUrl(p: Project) {
    return (
      this.config.PUBLIC_URL +
      "/hooks/chatwoot/" +
      p.id +
      "/" +
      unseal(p.hook_secret, this.config.MASTER_KEY)
    );
  }
  async rotate(id: string) {
    const secret = crypto.randomBytes(32).toString("hex");
    await this.db.query(
      "UPDATE projects SET api_secret=$2,version=version+1 WHERE id=$1",
      [id, seal(secret, this.config.MASTER_KEY)],
    );
    return { apiSecret: secret };
  }
  async test(id: string) {
    const p = await this.get(id),
      cw = new Chatwoot(p);
    const inbox = await cw.call("/inboxes/" + p.settings.inboxId);
    if (inbox.channel_type !== "Channel::Api")
      throw new AppError(400, "请创建 Chatwoot API Inbox");
    return {
      chatwoot: "ok",
      inbox: inbox.name,
      maxkb: "未消耗模型额度；请通过预览发送测试问题",
    };
  }
  async connect(id: string) {
    const p = await this.get(id),
      cw = new Chatwoot(p);
    await this.test(id);
    const definitions = await cw.call("/custom_attribute_definitions");
    if (!Array.isArray(definitions))
      throw new AppError(502, "Chatwoot 自定义属性接口格式不兼容");
    const attributes = [
      { key: "support_ticket", name: "用户提交的工单", type: 7, model: 0 },
      { key: "support_category", name: "工单分类", type: 0, model: 0 },
      { key: "support_subject", name: "工单摘要", type: 0, model: 0 },
      { key: "submitted_at", name: "工单提交时间", type: 0, model: 0 },
      { key: "support_email", name: "业务用户邮箱", type: 0, model: 1 },
    ];
    for (const field of attributes) {
      const modelName =
        field.model === 0 ? "conversation_attribute" : "contact_attribute";
      if (
        definitions.some(
          (d: any) =>
            d.attribute_key === field.key &&
            (d.attribute_model === field.model ||
              d.attribute_model === modelName),
        )
      )
        continue;
      await cw.call("/custom_attribute_definitions", "POST", {
        custom_attribute_definition: {
          attribute_key: field.key,
          attribute_display_name: field.name,
          attribute_display_type: field.type,
          attribute_model: field.model,
          attribute_description: "AI Support Hub",
        },
      });
    }
    let botId = p.settings.botId;
    if (!botId) {
      const bot = await cw.call("/agent_bots", "POST", {
        name: p.name + " AI",
        description: "MaxKB 知识库机器人",
        outgoing_url: this.hookUrl(p),
        bot_type: 0,
      });
      botId = bot.id;
      if (!botId) throw new AppError(502, "Chatwoot 未返回机器人 ID");
      const row = await this.db.one(
        "SELECT settings FROM projects WHERE id=$1",
        [id],
      );
      await this.db.query("UPDATE projects SET settings=$2 WHERE id=$1", [
        id,
        { ...row.settings, botId },
      ]);
    } else
      await cw.call("/agent_bots/" + botId, "PATCH", {
        outgoing_url: this.hookUrl(p),
      });
    const botDetails = await cw.call("/agent_bots/" + botId);
    if (!botDetails.secret)
      throw new AppError(
        400,
        "上游未返回机器人签名密钥，请使用配套 Chatwoot 版本和该 Account 的管理员 Token",
      );
    await this.db.query("UPDATE projects SET cw_hook_secret=$2 WHERE id=$1", [
      id,
      seal(botDetails.secret, this.config.MASTER_KEY),
    ]);
    await cw.call("/inboxes/" + p.settings.inboxId + "/set_agent_bot", "POST", {
      agent_bot: botId,
    });
    return { botId, hookUrl: this.hookUrl(p) };
  }
}
