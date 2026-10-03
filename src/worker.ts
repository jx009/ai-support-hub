import { Database } from "./db.js";
import { Projects } from "./projects.js";
import { Chatwoot, MaxKB } from "./providers.js";
import {
  incoming,
  outgoing,
  publicMessage,
  type Conversation,
} from "./model.js";
export class Worker {
  private stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private active = new Set<Promise<unknown>>();
  constructor(
    readonly db: Database,
    readonly projects: Projects,
  ) {}
  start() {
    for (let i = 0; i < this.projects.config.WORKER_CONCURRENCY; i++) {
      const tick = () => {
        if (this.stopped) return;
        const p = this.step()
          .catch(() => undefined)
          .finally(() => {
            this.active.delete(p);
            if (!this.stopped) {
              const timer = setTimeout(() => {
                this.timers.delete(timer);
                tick();
              }, 700);
              this.timers.add(timer);
            }
          });
        this.active.add(p);
      };
      tick();
    }
  }
  async close() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    await Promise.allSettled(this.active);
  }
  async step() {
    const jobs = (
      await this.db.query(
        "SELECT * FROM ai_jobs WHERE (state='pending' AND next_at<=now()) OR (state='running' AND updated_at<now()-interval '3 minutes') ORDER BY message_id LIMIT 10",
      )
    ).rows;
    for (const candidate of jobs) {
      const handled = await this.db.lock(
        "ai:" + candidate.conversation_id,
        async () => {
          const job = await this.db.one(
            "SELECT * FROM ai_jobs WHERE id=$1 AND ((state='pending' AND next_at<=now()) OR (state='running' AND updated_at<now()-interval '3 minutes'))",
            [candidate.id],
          );
          if (!job) return false;
          const older = await this.db.one(
            "SELECT id FROM ai_jobs WHERE conversation_id=$1 AND message_id<$2 AND state IN ('pending','running') LIMIT 1",
            [job.conversation_id, job.message_id],
          );
          if (older) return false;
          await this.db.query(
            "UPDATE ai_jobs SET state='running',attempts=attempts+1,updated_at=now() WHERE id=$1",
            [job.id],
          );
          try {
            await this.process(job);
            await this.db.query(
              "UPDATE ai_jobs SET state='done',error=NULL,updated_at=now() WHERE id=$1",
              [job.id],
            );
          } catch {
            const exhausted = job.attempts >= 2;
            await this.db.query(
              "UPDATE ai_jobs SET state=$2,error=$3,next_at=now()+interval '10 seconds',updated_at=now() WHERE id=$1",
              [
                job.id,
                exhausted ? "failed" : "pending",
                "AI 处理或消息同步失败，可查看上游连接并重试",
              ],
            );
          }
          return true;
        },
        true,
      );
      if (handled) return;
    }
  }
  async process(job: any) {
    const p = await this.projects.get(job.project_id),
      cw = new Chatwoot(p);
    let c = await this.db.one<Conversation>(
      "SELECT * FROM conversations WHERE id=$1",
      [job.conversation_id],
    );
    if (!c || c.ticket || !c.remote_id || !p.enabled) return;
    const version = c.handoff_version;
    const remote = await cw.details(c.remote_id);
    if (
      remote.status !== "pending" ||
      remote.custom_attributes?.support_ticket ||
      Number(remote.inbox_id) !== p.settings.inboxId
    )
      return;
    const history = await cw.history(c.remote_id, 200);
    if (
      history.some(
        (m) => m.content_attributes?.support_operation_id === "ai:" + job.id,
      )
    )
      return;
    const target = history.find((m) => m.id === Number(job.message_id));
    if (!target || !incoming(target) || !publicMessage(target)) return;
    let result = job.result;
    if (!result) {
      try {
        result = await new MaxKB(p, this.projects.config).answer(
          history
            .filter((m) => m.id <= Number(job.message_id) && publicMessage(m))
            .slice(-30)
            .map((m) => ({
              role: incoming(m) ? "user" : "assistant",
              content: m.content || "",
            })),
        );
      } catch {
        result = {
          answer:
            "暂时未能从知识库获得有效回答。你可以稍后再问，或点击“提交工单”描述问题，由客服跟进。",
          references: [],
          fallback: true,
        };
      }
      await this.db.query(
        "UPDATE ai_jobs SET result=$2,updated_at=now() WHERE id=$1",
        [job.id, result],
      );
    }
    await this.db.lock("publish:" + c.id, async () => {
      c = await this.db.one<Conversation>(
        "SELECT * FROM conversations WHERE id=$1",
        [job.conversation_id],
      );
      if (!c || c.ticket || c.handoff_version !== version) return;
      const latest = await cw.details(c.remote_id!);
      if (
        latest.status !== "pending" ||
        latest.custom_attributes?.support_ticket
      )
        return;
      const recent = await cw.history(c.remote_id!);
      if (
        recent.some(
          (m) => m.content_attributes?.support_operation_id === "ai:" + job.id,
        )
      )
        return;
      await cw.post(c.remote_id!, result.answer, "outgoing", "ai:" + job.id, {
        support_ai: true,
        support_references: result.references,
        support_fallback: result.fallback,
        in_reply_to: Number(job.message_id),
      });
      await this.db.query(
        "UPDATE conversations SET updated_at=now() WHERE id=$1",
        [c.id],
      );
    });
  }
}
