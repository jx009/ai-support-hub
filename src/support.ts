import crypto from "node:crypto";
import { Database } from "./db.js";
import { Projects } from "./projects.js";
import { AppError, hash, type Session } from "./security.js";
import { Chatwoot } from "./providers.js";
import {
  incoming,
  publicMessage,
  cleanMessage,
  type Conversation,
  type Project,
} from "./model.js";
export class Support {
  constructor(
    readonly db: Database,
    readonly projects: Projects,
  ) {}
  async owned(s: Session, id: string): Promise<Conversation> {
    const c = await this.db.one<Conversation>(
      "SELECT * FROM conversations WHERE id=$1 AND project_id=$2 AND external_id=$3",
      [id, s.pid, s.uid],
    );
    if (!c || !c.remote_id) throw new AppError(404, "咨询不存在");
    return c;
  }
  async contact(p: Project, s: Session) {
    return this.db.lock("contact:" + p.id + ":" + s.uid, async () => {
      const existing = await this.db.one(
        "SELECT * FROM contacts WHERE project_id=$1 AND external_id=$2",
        [p.id, s.uid],
      );
      if (existing) return existing;
      const cw = new Chatwoot(p),
        identifier = hash(p.id + ":" + s.uid);
      const found = await cw.call("/contacts/search?q=" + identifier);
      let remote = found.payload?.find((x: any) => x.identifier === identifier);
      const source = identifier;
      if (!remote) {
        const result = await cw.call("/contacts", "POST", {
          name: s.name || s.email || "用户",
          identifier,
          inbox_id: p.settings.inboxId,
          source_id: source,
          // Email is metadata, not identity. Do not merge distinct users by mailbox.
          custom_attributes: { support_email: s.email },
        });
        remote = result.payload?.contact || result.payload || result;
      }
      if (!Number.isSafeInteger(remote?.id))
        throw new AppError(502, "Chatwoot 联系人返回格式错误");
      let contactSource = remote.contact_inboxes?.find(
        (x: any) => Number(x.inbox?.id || x.inbox_id) === p.settings.inboxId,
      )?.source_id;
      if (!contactSource) {
        const full = await cw.call("/contacts/" + remote.id);
        const detail = full.payload || full;
        contactSource = detail.contact_inboxes?.find(
          (x: any) => Number(x.inbox?.id || x.inbox_id) === p.settings.inboxId,
        )?.source_id;
      }
      if (!contactSource) {
        const ci = await cw.call(
          "/contacts/" + remote.id + "/contact_inboxes",
          "POST",
          { inbox_id: p.settings.inboxId, source_id: source },
        );
        contactSource = ci.source_id || ci.payload?.source_id;
      }
      if (!contactSource) throw new AppError(502, "Chatwoot 未返回联系人渠道");
      return this.db.one(
        "INSERT INTO contacts(id,project_id,external_id,remote_id,source_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [crypto.randomUUID(), p.id, s.uid, remote.id, contactSource],
      );
    });
  }
  async create(p: Project, s: Session, key: string) {
    return this.db.lock(
      "conversation:" + p.id + ":" + s.uid + ":" + key,
      async () => {
        let row = await this.db.one<Conversation>(
          "SELECT * FROM conversations WHERE project_id=$1 AND external_id=$2 AND request_key=$3",
          [p.id, s.uid, key],
        );
        if (row?.remote_id) return row;
        const contact = await this.contact(p, s);
        if (!contact) throw new AppError(409, "正在创建会话");
        const cw = new Chatwoot(p);
        if (!row)
          row = await this.db.one<Conversation>(
            "INSERT INTO conversations(id,project_id,external_id,request_key) VALUES($1,$2,$3,$4) RETURNING *",
            [crypto.randomUUID(), p.id, s.uid, key],
          );
        if (!row) throw new Error("Missing conversation row");
        const list = await cw.call(
          "/contacts/" + contact.remote_id + "/conversations",
        );
        let remote = list.payload?.find(
          (x: any) =>
            x.additional_attributes?.support_conversation_id === row!.id,
        );
        if (!remote)
          remote = await cw.call("/conversations", "POST", {
            source_id: contact.source_id,
            inbox_id: p.settings.inboxId,
            contact_id: Number(contact.remote_id),
            status: "pending",
            additional_attributes: { support_conversation_id: row.id },
          });
        if (!Number.isSafeInteger(remote.id))
          throw new AppError(502, "Chatwoot 未返回会话 ID");
        await this.db.query(
          "UPDATE conversations SET remote_id=$2 WHERE id=$1",
          [row.id, remote.id],
        );
        return { ...row, remote_id: String(remote.id) };
      },
    );
  }
  async operation(
    p: Project,
    s: Session,
    c: Conversation,
    kind: string,
    key: string,
    payload: unknown,
    fn: (op: any) => Promise<unknown>,
  ) {
    return this.db.lock(
      "operation:" + p.id + ":" + s.uid + ":" + kind + ":" + key,
      async () => {
        const ph = hash(JSON.stringify(payload));
        let op = await this.db.one(
          "SELECT * FROM operations WHERE project_id=$1 AND external_id=$2 AND kind=$3 AND request_key=$4",
          [p.id, s.uid, kind, key],
        );
        if (op && (op.payload_hash !== ph || op.conversation_id !== c.id))
          throw new AppError(409, "同一个请求标识不能用于不同内容");
        if (op?.status === "done") return op.result;
        if (!op)
          op = await this.db.one(
            "INSERT INTO operations(id,project_id,conversation_id,external_id,kind,request_key,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [crypto.randomUUID(), p.id, c.id, s.uid, kind, key, ph],
          );
        try {
          const result = await fn(op);
          await this.db.query(
            "UPDATE operations SET status='done',result=$2,error=NULL WHERE id=$1",
            [op.id, result],
          );
          return result;
        } catch (e) {
          await this.db.query(
            "UPDATE operations SET status='failed',error=$2 WHERE id=$1",
            [op.id, e instanceof AppError ? e.message : "操作失败"],
          );
          throw e;
        }
      },
    );
  }
  async send(p: Project, s: Session, id: string, text: string, key: string) {
    const c = await this.owned(s, id);
    return this.operation(p, s, c, "message", key, { text }, async (op) => {
      const cw = new Chatwoot(p),
        history = await cw.history(c.remote_id!);
      const sent = history.find(
        (m) => m.content_attributes?.support_operation_id === op.id,
      );
      if (sent) return cleanMessage(sent);
      // Never blindly resend an ambiguous write. A retry first searches the upstream marker.
      if (op.status === "failed")
        throw new AppError(
          409,
          "上次发送结果尚未确认，请刷新记录后再处理",
          "WRITE_UNCERTAIN",
        );
      const current = await cw.details(c.remote_id!);
      if (current.status === "resolved")
        await cw.status(c.remote_id!, c.ticket ? "open" : "pending");
      const m = await cw.post(c.remote_id!, text, "incoming", op.id);
      await this.db.query(
        "UPDATE conversations SET updated_at=now() WHERE id=$1",
        [id],
      );
      // The AgentBot webhook is the sole path that schedules AI work.
      return cleanMessage(m);
    });
  }
  async ticket(
    p: Project,
    s: Session,
    id: string,
    category: string,
    description: string,
    key: string,
  ) {
    const c = await this.owned(s, id);
    if (!p.settings.categories.some((x) => x.code === category))
      throw new AppError(400, "无效的问题分类");
    return this.operation(
      p,
      s,
      c,
      "ticket",
      key,
      { category, description },
      async (op) => {
        return this.db.lock("publish:" + id, async () => {
          const current = await this.owned(s, id),
            cw = new Chatwoot(p);
          const remote = await cw.details(c.remote_id!);
          if (current.ticket && remote.custom_attributes?.support_ticket) {
            if (remote.status === "pending")
              await cw.status(c.remote_id!, "open");
            return { id: c.id, ticket: true };
          }
          // Persist handoff before network calls. Failures keep AI stopped and allow the same request to resume.
          await this.db.query(
            "UPDATE conversations SET ticket=true,handoff_version=handoff_version+1,category=$2,subject=$3,updated_at=now() WHERE id=$1",
            [id, category, description.slice(0, 100)],
          );
          const history = await cw.history(c.remote_id!);
          if (
            !history.some(
              (m) => m.content_attributes?.support_operation_id === op.id,
            )
          )
            await cw.post(
              c.remote_id!,
              "【提交工单 · " +
                p.settings.categories.find((x) => x.code === category)!.name +
                "】\n" +
                description,
              "incoming",
              op.id,
            );
          await cw.call(
            "/conversations/" + c.remote_id + "/custom_attributes",
            "POST",
            {
              custom_attributes: {
                ...remote.custom_attributes,
                support_ticket: true,
                support_category: category,
                support_subject: description.slice(0, 100),
                submitted_at: new Date().toISOString(),
              },
            },
          );
          await cw.status(c.remote_id!, "open");
          return { id: c.id, ticket: true };
        });
      },
    );
  }
  async list(p: Project, s: Session, tickets = false, before?: string) {
    if (before) await this.owned(s, before);
    const rows = (
      await this.db.query(
        "SELECT * FROM conversations WHERE project_id=$1 AND external_id=$2 AND remote_id IS NOT NULL " +
          (tickets ? "AND ticket=true " : "") +
          (before
            ? "AND (updated_at,id)<(SELECT updated_at,id FROM conversations WHERE id=$3 AND project_id=$1 AND external_id=$2) "
            : "") +
          "ORDER BY updated_at DESC,id DESC LIMIT 50",
        before ? [p.id, s.uid, before] : [p.id, s.uid],
      )
    ).rows;
    const cw = new Chatwoot(p),
      result = [];
    for (let i = 0; i < rows.length; i += 5) {
      result.push(
        ...(await Promise.all(
          rows.slice(i, i + 5).map(async (c) => {
            const remote = await cw.details(c.remote_id);
            return {
              id: c.id,
              ticket: c.ticket,
              subject: c.subject,
              category: c.category,
              status: remote.status,
              createdAt: c.created_at,
              updatedAt: c.updated_at,
            };
          }),
        )),
      );
    }
    return result;
  }
  async messages(p: Project, s: Session, id: string, before?: number) {
    const c = await this.owned(s, id),
      cw = new Chatwoot(p);
    const [remote, all] = await Promise.all([
      cw.details(c.remote_id!),
      cw.messages(c.remote_id!, before),
    ]);
    const jobs = await this.db.one(
      "SELECT count(*) FILTER (WHERE state IN ('pending','running'))::int AS pending,count(*) FILTER (WHERE state='failed')::int AS failed FROM ai_jobs WHERE conversation_id=$1",
      [id],
    );
    const last = all.at(-1);
    const waitingHook =
      last &&
      incoming(last) &&
      !c.ticket &&
      remote.status === "pending" &&
      Date.now() - Number(last.created_at) * 1000 < 15000;
    return {
      conversation: { id, ticket: c.ticket, status: remote.status },
      messages: all.filter(publicMessage).map(cleanMessage),
      before: all.length ? all[0].id : null,
      busy: !c.ticket && (jobs.pending > 0 || !!waitingHook),
      failed: jobs.failed > 0,
    };
  }
  async hook(p: Project, event: any) {
    if (event.event !== "message_created" || event.private || !incoming(event))
      return;
    const remoteId = event.conversation?.id,
      mid = event.id;
    if (
      !Number.isSafeInteger(remoteId) ||
      !Number.isSafeInteger(mid) ||
      Number(event.account?.id) !== p.settings.accountId
    )
      return;
    const c = await this.db.one<Conversation>(
      "SELECT * FROM conversations WHERE project_id=$1 AND remote_id=$2",
      [p.id, remoteId],
    );
    if (!c || c.ticket || !p.enabled) return;
    // Signature is verified by the HTTP boundary. Acknowledge quickly: Chatwoot has a short webhook timeout.
    // The worker re-reads the real upstream conversation and message before invoking MaxKB.
    await this.db.query(
      "INSERT INTO ai_jobs(id,project_id,conversation_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,message_id) DO NOTHING",
      [crypto.randomUUID(), p.id, c.id, mid],
    );
  }
}
