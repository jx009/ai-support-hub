import { beforeAll, afterAll, describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { fixture, waitFor, testAdmin } from "./fixture";
import { hash, seal, unseal } from "../src/security";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
}, 30000);
afterAll(async () => {
  await f?.close();
});
async function api(
  boot: any,
  path: string,
  method = "GET",
  body?: unknown,
  key = crypto.randomUUID(),
) {
  const r = await fetch(f.config.PUBLIC_URL + "/support/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + boot.session.token,
      "X-Embed-Origin": boot.embedOrigin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
async function chat(boot: any) {
  const r = await api(boot, "/conversations", "POST", {});
  expect(r.status).toBe(200);
  return r.data.id;
}
async function sendAndWork(boot: any, id: string, text: string) {
  const r = await api(boot, "/conversations/" + id + "/messages", "POST", {
    content: text,
  });
  expect(r.status).toBe(202);
  await waitFor(
    async () =>
      !!(await f.db.one("SELECT id FROM ai_jobs WHERE conversation_id=$1", [
        id,
      ])),
  );
  await f.worker.step();
}
describe("Project identity and data boundaries", () => {
  it("bootstrap sends the same three sampled questions in both API fields while retaining all admin settings", async () => {
    const original = await f.projects.get(f.other.id);
    const questions = Array.from({ length: 7 }, (_, i) => ({ id: `sample-${i}`, question: `预设问题 ${i}`, enabled: i !== 6 }));
    try {
      await f.projects.save({ ...original, settings: { ...original.settings, questions } }, original.id);
      const boot = (await f.bootstrap(f.other, "sample-user")).data;
      expect(boot.project.questions).toHaveLength(3);
      expect(boot.presetQuestions).toEqual(boot.project.questions);
      expect(new Set(boot.presetQuestions.map((q: any) => q.id)).size).toBe(3);
      expect(boot.presetQuestions.every((q: any) => q.enabled && q.id !== "sample-6")).toBe(true);
      expect((await f.projects.get(original.id)).settings.questions).toHaveLength(7);
    } finally {
      await f.projects.save(original, original.id);
    }
  });
  it("rejects a correct callback URL with missing Chatwoot HMAC", async () => {
    const p = await f.projects.get(f.project.id);
    const r = await fetch(f.projects.hookUrl(p), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "message_created" }),
    });
    expect(r.status).toBe(401);
  });
  it("prevents account reuse across projects", async () => {
    await expect(
      f.projects.save({
        code: "duplicate",
        name: "重复",
        enabled: false,
        settings: f.project.settings,
      }),
    ).rejects.toThrow("独立 Chatwoot Account");
  });
  it("parallel independent conversations do not exhaust nested database locks", async () => {
    const boots = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.bootstrap(f.other, "parallel-" + i),
      ),
    );
    const ids = await Promise.all(boots.map((b) => chat(b.data)));
    expect(new Set(ids).size).toBe(20);
  });
  it("encrypts credentials with authenticated encryption", () => {
    const v = seal("secret", f.config.MASTER_KEY);
    expect(unseal(v, f.config.MASTER_KEY)).toBe("secret");
    expect(v).not.toContain("secret");
    expect(() => unseal(v.slice(0, -2) + "AA", f.config.MASTER_KEY)).toThrow();
  });
  it("bootstrap includes presets but never upstream or project secrets; rejects replay and tampering", async () => {
    const b = await f.bootstrap();
    expect(b.data.project.questions[0].question).toContain("API Key");
    expect(JSON.stringify(b.data)).not.toContain("cw-1");
    expect(b.data.session.expiresIn).toBe(900);
    const replay = await fetch(f.config.PUBLIC_URL + b.path, {
      method: "POST",
      headers: b.headers,
      body: b.body,
    });
    expect(replay.status).toBe(401);
    const tamper = await fetch(f.config.PUBLIC_URL + b.path, {
      method: "POST",
      headers: b.headers,
      body: b.body.replace("user-1", "user-2"),
    });
    expect(tamper.status).toBe(401);
  });
  it("rejects unauthenticated admin and forged callback requests", async () => {
    expect(
      (await fetch(f.config.PUBLIC_URL + "/admin/api/projects")).status,
    ).toBe(401);
    expect(
      (
        await fetch(
          f.config.PUBLIC_URL + "/hooks/chatwoot/" + f.project.id + "/fake",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        )
      ).status,
    ).toBe(401);
  });
  it("cannot access another user or project, even with same external ID", async () => {
    const a = (await f.bootstrap()).data,
      b = (await f.bootstrap(f.project, "user-2")).data,
      c = (await f.bootstrap(f.other)).data;
    const id = await chat(a);
    expect((await api(b, "/conversations/" + id + "/messages")).status).toBe(
      404,
    );
    expect((await api(c, "/conversations/" + id + "/messages")).status).toBe(
      404,
    );
    const forged = await fetch(
      f.config.PUBLIC_URL + "/support/v1/conversations",
      {
        headers: {
          Authorization: "Bearer " + a.session.token,
          "X-Embed-Origin": "https://evil.test",
        },
      },
    );
    expect(forged.status).toBe(403);
  });
  it("only permits configured embedding domains", async () => {
    const r = await fetch(f.config.PUBLIC_URL + "/widget?project=letaicode");
    expect(r.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://website.test",
    );
  });
});
describe("AI-first conversations and tickets", () => {
  it("creates idempotent conversations and message writes and rejects changed payload", async () => {
    const boot = (await f.bootstrap(f.project, "idempotent")).data,
      key = crypto.randomUUID();
    const a = await api(boot, "/conversations", "POST", {}, key),
      b = await api(boot, "/conversations", "POST", {}, key);
    expect(a.data.id).toBe(b.data.id);
    const mkey = crypto.randomUUID(),
      path = "/conversations/" + a.data.id + "/messages";
    const m1 = await api(boot, path, "POST", { content: "hello" }, mkey),
      m2 = await api(boot, path, "POST", { content: "hello" }, mkey);
    expect(m1.data.id).toBe(m2.data.id);
    expect(
      (await api(boot, path, "POST", { content: "different" }, mkey)).status,
    ).toBe(409);
    await waitFor(
      async () =>
        !!(await f.db.one("SELECT id FROM ai_jobs WHERE conversation_id=$1", [
          a.data.id,
        ])),
    );
    await f.worker.step();
  });
  it("answers from each project application and keeps AI context across turns", async () => {
    const b = (await f.bootstrap(f.other, "context")).data,
      id = await chat(b);
    await sendAndWork(b, id, "第一问");
    let r = await api(b, "/conversations/" + id + "/messages");
    expect(r.data.messages.at(-1).content).toContain("知识库(other)");
    expect(r.data.messages.at(-1).role).toBe("assistant");
    expect(r.data.conversation.ticket).toBe(false);
    const sent = await api(b, "/conversations/" + id + "/messages", "POST", {
      content: "第二问",
    });
    expect(sent.status).toBe(202);
    await waitFor(
      async () =>
        Number(
          (
            await f.db.one(
              "SELECT count(*) FROM ai_jobs WHERE conversation_id=$1",
              [id],
            )
          ).count,
        ) === 2,
    );
    await f.worker.step();
    const call = f.maxkbCalls.at(-1);
    expect(call.messages.some((x: any) => x.content === "第一问")).toBe(true);
    expect(call.messages.some((x: any) => x.role === "assistant")).toBe(true);
  });
  it("fallback suggests ticket without automatically creating a human task", async () => {
    const b = (await f.bootstrap(f.project, "fallback")).data,
      id = await chat(b);
    await sendAndWork(b, id, "NO_ANSWER");
    const r = await api(b, "/conversations/" + id + "/messages");
    expect(r.data.messages.at(-1).suggestTicket).toBe(true);
    expect(r.data.conversation.ticket).toBe(false);
    expect(r.data.conversation.status).toBe("pending");
  });
  it("does not reclaim a long AI task until its ten-minute deadline and recovery margin expire", async () => {
    const previousTimeout = f.config.AI_TIMEOUT_MS;
    f.config.AI_TIMEOUT_MS = 600000;
    try {
      const boot = (await f.bootstrap(f.project, 'long-ai-deadline')).data;
      const id = await chat(boot);
      await api(boot, '/conversations/' + id + '/messages', 'POST', { content: '等待较长时间的问答' });
      await waitFor(async () => !!(await f.db.one('SELECT id FROM ai_jobs WHERE conversation_id=$1', [id])));
      await f.db.query("UPDATE ai_jobs SET state='running', updated_at=now()-interval '4 minutes' WHERE conversation_id=$1", [id]);
      await f.worker.step();
      expect((await f.db.one('SELECT state FROM ai_jobs WHERE conversation_id=$1', [id])).state).toBe('running');
      await f.db.query("UPDATE ai_jobs SET updated_at=now()-interval '13 minutes' WHERE conversation_id=$1", [id]);
      await f.worker.step();
      expect((await f.db.one('SELECT state FROM ai_jobs WHERE conversation_id=$1', [id])).state).toBe('done');
      const messages = await api(boot, '/conversations/' + id + '/messages');
      expect(messages.data.messages.at(-1).role).toBe('assistant');
    } finally {
      f.config.AI_TIMEOUT_MS = previousTimeout;
    }
  });
  it("submits a ticket once, keeps history and filters internal notes", async () => {
    const b = (await f.bootstrap(f.project, "ticket")).data,
      id = await chat(b);
    await sendAndWork(b, id, "原始问题");
    const key = crypto.randomUUID(),
      body = {
        conversationId: id,
        category: "technical",
        description: "还是没有解决",
      };
    expect((await api(b, "/tickets", "POST", body, key)).status).toBe(200);
    expect((await api(b, "/tickets", "POST", body, key)).status).toBe(200);
    const row = await f.db.one("SELECT * FROM conversations WHERE id=$1", [id]),
      remote = f.conversations.find((c) => c.id === Number(row.remote_id));
    expect(remote.status).toBe("open");
    expect(
      remote.messages.filter((m: any) => m.content.includes("【提交工单"))
        .length,
    ).toBe(1);
    remote.messages.push(
      {
        id: 90001,
        message_type: 1,
        private: true,
        content: "内部备注绝不能展示",
        created_at: 0,
      },
      {
        id: 90002,
        message_type: 1,
        private: false,
        content: "客服已处理",
        created_at: 0,
      },
    );
    const r = await api(b, "/conversations/" + id + "/messages");
    expect(JSON.stringify(r.data)).not.toContain("内部备注");
    expect(r.data.messages.at(-1).role).toBe("agent");
    expect((await api(b, "/tickets")).data.some((c: any) => c.id === id)).toBe(
      true,
    );
  });
  it("drops a late AI answer after the user submits a ticket", async () => {
    const b = (await f.bootstrap(f.project, "race")).data,
      id = await chat(b);
    await api(b, "/conversations/" + id + "/messages", "POST", {
      content: "DELAY",
    });
    await waitFor(
      async () =>
        !!(await f.db.one("SELECT id FROM ai_jobs WHERE conversation_id=$1", [
          id,
        ])),
    );
    const working = f.worker.step();
    await waitFor(() => f.delayed());
    expect(
      (
        await api(b, "/tickets", "POST", {
          conversationId: id,
          category: "technical",
          description: "转成工单",
        })
      ).status,
    ).toBe(200);
    f.release();
    await working;
    const r = await api(b, "/conversations/" + id + "/messages");
    expect(
      r.data.messages.filter((m: any) => m.role === "assistant"),
    ).toHaveLength(0);
  });
  it("revokes previous sessions on secret rotation", async () => {
    const b = (await f.bootstrap()).data;
    await f.projects.rotate(f.project.id);
    expect((await api(b, "/conversations")).status).toBe(401);
  });
});
