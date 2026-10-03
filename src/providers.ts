import type { Config } from "./config.js";
import type { CWMessage, Project } from "./model.js";
import { AppError } from "./security.js";
import { request, type Dispatcher } from "undici";
export async function jsonRequest(
  url: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
  timeout = 15000,
): Promise<any> {
  let res: Dispatcher.ResponseData;
  try {
    // Explicit transport deadlines avoid fetch's shorter built-in header wait.
    res = await request(url, {
      method: method as Dispatcher.HttpMethod,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      headersTimeout: timeout,
      bodyTimeout: timeout,
      maxRedirections: 0,
    });
  } catch {
    throw new AppError(
      502,
      "上游服务暂时无法连接，请稍后重试",
      "UPSTREAM_UNAVAILABLE",
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    // Cancelling the unused body emits an abort error on this Node stream.
    res.body.on("error", () => undefined);
    res.body.destroy();
    throw new AppError(
      502,
      "上游接口返回错误（" + res.statusCode + "）",
      "UPSTREAM_ERROR",
    );
  }
  const raw = await res.body.text();
  if (!raw.trim()) return {};
  if (raw.length > 4_000_000) throw new AppError(502, "上游响应过大");
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(502, "上游返回格式错误");
  }
}
export class Chatwoot {
  constructor(readonly p: Project) {}
  async call(path: string, method = "GET", body?: unknown) {
    return jsonRequest(
      this.p.settings.chatwootUrl +
        "/api/v1/accounts/" +
        this.p.settings.accountId +
        path,
      { api_access_token: this.p.settings.chatwootToken },
      method,
      body,
    );
  }
  async details(id: string | number) {
    return this.call("/conversations/" + id);
  }
  async messages(id: string | number, before?: number): Promise<CWMessage[]> {
    const data = await this.call(
      "/conversations/" +
        id +
        "/messages" +
        (before ? "?before=" + before : ""),
    );
    if (!Array.isArray(data.payload))
      throw new AppError(502, "Chatwoot 消息格式不兼容");
    return data.payload.sort((a: CWMessage, b: CWMessage) => a.id - b.id);
  }
  async history(id: string | number, max = 200): Promise<CWMessage[]> {
    let all: CWMessage[] = [];
    let before: number | undefined;
    while (all.length < max) {
      const page = await this.messages(id, before);
      if (!page.length) break;
      if (before && page[0].id >= before) break;
      all = [...page, ...all];
      before = page[0].id;
    }
    return all.slice(-max);
  }
  async post(
    id: string | number,
    content: string,
    type: "incoming" | "outgoing",
    key: string,
    attrs: Record<string, unknown> = {},
  ) {
    return this.call("/conversations/" + id + "/messages", "POST", {
      content,
      content_type: "text",
      message_type: type,
      private: false,
      content_attributes: { ...attrs, support_operation_id: key },
      ...(type === "outgoing" && this.p.settings.botId
        ? { sender_type: "AgentBot", sender_id: this.p.settings.botId }
        : {}),
    });
  }
  async status(id: string | number, status: string) {
    return this.call("/conversations/" + id + "/toggle_status", "POST", {
      status,
    });
  }
}
export class MaxKB {
  constructor(
    readonly p: Project,
    readonly config: Config,
  ) {}
  async answer(history: { role: string; content: string }[]) {
    const s = this.p.settings;
    const data = await jsonRequest(
      s.maxkbUrl.replace(/\/+$/, "") + "/chat/completions",
      { Authorization: "Bearer " + s.maxkbKey },
      "POST",
      {
        model: s.model,
        stream: false,
        messages: [{ role: "system", content: s.systemPrompt }, ...history],
      },
      this.config.AI_TIMEOUT_MS,
    );
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim())
      throw new AppError(502, "知识库暂时没有返回有效回答", "EMPTY_ANSWER");
    // The compatibility API may not expose retrieval references: never synthesize them.
    return {
      answer: answer.slice(0, 30000),
      references: [] as unknown[],
      fallback: false,
    };
  }
}
