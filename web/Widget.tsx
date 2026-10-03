import React, { useState, useEffect, useRef, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Bootstrap, Conversation, Message } from "./types";
import { requestKey } from "./request-key";
const statusLabel: Record<string, string> = {
  pending: "AI 接待",
  open: "待处理",
  snoozed: "等待跟进",
  resolved: "已解决",
};
export default function Widget() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState<"ai" | "tickets">("ai");
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [current, setCurrent] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]),
    [busy, setBusy] = useState(false),
    [sending, setSending] = useState(false),
    [draft, setDraft] = useState("");
  const [ticketOpen, setTicketOpen] = useState(false),
    [category, setCategory] = useState(""),
    [description, setDescription] = useState(""),
    [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false),
    lastRefresh = useRef(0);
  const [cursor, setCursor] = useState<number | null>(null),
    [ready, setReady] = useState(false);
  const bootRef = useRef(boot),
    currentRef = useRef(current),
    pane = useRef<HTMLDivElement>(null);
  const sendKey = useRef<{ text: string; key: string } | null>(null),
    createKey = useRef(requestKey()),
    ticketKey = useRef(requestKey()),
    polling = useRef(false);
  bootRef.current = boot;
  currentRef.current = current;
  function tellParent(type: string) {
    if (type === "support:refresh") {
      if (Date.now() - lastRefresh.current < 10000) return;
      lastRefresh.current = Date.now();
    }
    const b = bootRef.current;
    window.parent.postMessage({ type }, b?.embedOrigin || "*");
  }
  const call = useCallback(
    async (path: string, method = "GET", data?: unknown, key?: string) => {
      const b = bootRef.current;
      if (!b) throw new Error("正在连接客服");
      const r = await fetch("/support/v1" + path, {
        method,
        headers: {
          Authorization: "Bearer " + b.session.token,
          "Content-Type": "application/json",
          "X-Embed-Origin": b.embedOrigin,
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const value = await r.json();
      if (!r.ok) {
        if (r.status === 401) tellParent("support:refresh");
        throw new Error(value.error || "请求失败");
      }
      return value;
    },
    [],
  );
  useEffect(() => {
    let accepting = true;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== "support:init")
        return;
      const b = event.data.bootstrap as Bootstrap;
      if (
        !b?.session?.token ||
        b.embedOrigin !== event.origin ||
        b.project.code !== new URLSearchParams(location.search).get("project")
      )
        return;
      if (new URL(b.publicUrl).origin !== location.origin) return;
      accepting = false;
      setBoot(b);
      setError("");
    };
    window.addEventListener("message", receive);
    const announce = () => {
      if (accepting) window.parent.postMessage({ type: "support:ready" }, "*");
    };
    announce();
    const t = setInterval(announce, 2000);
    return () => {
      clearInterval(t);
      window.removeEventListener("message", receive);
    };
  }, []);
  const refreshList = useCallback(async () => {
    const list = await call("/conversations");
    setConversations(list);
    setHasMore(list.length === 50);
    return list as Conversation[];
  }, [call]);
  useEffect(() => {
    if (!boot) return;
    let live = true;
    call("/session")
      .then(() => refreshList())
      .then((list) => {
        if (!live) return;
        setReady(true);
        if (!currentRef.current) {
          const last = list.find((c) => !c.ticket);
          if (last) setCurrent(last);
        }
      })
      .catch((e) => live && setError(e.message));
    const t = setTimeout(
      () => tellParent("support:refresh"),
      Math.max(30000, boot.session.expiresIn * 1000 - 60000),
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [boot, call, refreshList]);
  const refreshMessages = useCallback(async () => {
    const c = currentRef.current;
    if (!c || polling.current) return;
    polling.current = true;
    try {
      const r = await call("/conversations/" + c.id + "/messages");
      if (currentRef.current?.id !== c.id) return;
      setMessages((previous) => {
        const byId = new Map(previous.map((m) => [m.id, m]));
        r.messages.forEach((m: Message) => byId.set(m.id, m));
        return [...byId.values()].sort((a, b) => a.id - b.id);
      });
      setCursor((old) =>
        old === null ? r.before : Math.min(old, r.before || old),
      );
      setBusy(r.busy);
      setCurrent((old) =>
        old?.id === c.id
          ? {
              ...old,
              status: r.conversation.status,
              ticket: r.conversation.ticket,
            }
          : old,
      );
      if (r.failed) setError("AI 处理暂时失败，可提交工单或稍后重新提问。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      polling.current = false;
    }
  }, [call]);
  useEffect(() => {
    setMessages([]);
    setCursor(null);
    setBusy(false);
    if (!current) return;
    void refreshMessages();
    const t = setInterval(() => void refreshMessages(), 2500);
    return () => clearInterval(t);
  }, [current?.id, refreshMessages]);
  useEffect(() => {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [messages.length, busy]);
  async function ensureConversation() {
    if (currentRef.current) return currentRef.current;
    const r = await call("/conversations", "POST", {}, createKey.current);
    const c: Conversation = {
      id: r.id,
      ticket: false,
      subject: null,
      category: null,
      status: "pending",
      createdAt: r.created_at,
    };
    currentRef.current = c;
    setCurrent(c);
    return c;
  }
  async function send(text = draft) {
    if (!text.trim() || sending || (!current?.ticket && busy)) return;
    setSending(true);
    setError("");
    if (sendKey.current?.text !== text)
      sendKey.current = { text, key: requestKey() };
    try {
      const c = await ensureConversation();
      await call(
        "/conversations/" + c.id + "/messages",
        "POST",
        { content: text },
        sendKey.current.key,
      );
      setDraft("");
      sendKey.current = null;
      await refreshMessages();
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  function newChat() {
    setCurrent(null);
    currentRef.current = null;
    createKey.current = requestKey();
    sendKey.current = null;
    setDraft("");
    setMessages([]);
    setError("");
    setBusy(false);
    setTab("ai");
  }
  function openTicket() {
    setCategory(boot?.project.categories[0]?.code || "");
    setDescription("");
    ticketKey.current = requestKey();
    setTicketOpen(true);
  }
  async function submitTicket(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const c = await ensureConversation();
      await call(
        "/tickets",
        "POST",
        { conversationId: c.id, category, description },
        ticketKey.current,
      );
      const next = {
        ...c,
        ticket: true,
        status: "open",
        subject: description.slice(0, 100),
      };
      currentRef.current = next;
      setCurrent(next);
      setTab("tickets");
      setTicketOpen(false);
      setBusy(false);
      await refreshList();
      await refreshMessages();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function moreConversations() {
    const last = conversations.at(-1);
    if (!last) return;
    try {
      const list = await call("/conversations?before=" + last.id);
      setConversations((old) => [
        ...new Map([...old, ...list].map((c) => [c.id, c])).values(),
      ]);
      setHasMore(list.length === 50);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function older() {
    if (!current || !cursor) return;
    try {
      const r = await call(
        "/conversations/" + current.id + "/messages?before=" + cursor,
      );
      setMessages((old) => [...r.messages, ...old]);
      setCursor(r.before);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const tickets = conversations.filter(
    (c) => c.ticket && (!search || (c.subject || "").includes(search)),
  );
  return (
    <div
      className="widget"
      style={
        { "--accent": boot?.project.color || "#4f46e5" } as React.CSSProperties
      }
    >
      <header className="widget-header">
        <div className="brand-icon">✦</div>
        <div>
          <strong>{boot?.project.name || "AI 客服中心"}</strong>
          <small>知识库问答 · 工单跟进</small>
        </div>
        <button
          className="icon-button"
          aria-label="关闭客服"
          onClick={() => tellParent("support:close")}
        >
          ×
        </button>
      </header>
      <nav className="tabs">
        <button
          className={tab === "ai" ? "selected" : ""}
          onClick={() => {
            setTab("ai");
            if (current?.ticket) newChat();
          }}
        >
          ✦ 智能客服
        </button>
        <button
          className={tab === "tickets" ? "selected" : ""}
          onClick={() => {
            setTab("tickets");
            void refreshList().catch((e) => setError(e.message));
          }}
        >
          ▤ 我的工单
        </button>
      </nav>
      {error && (
        <div role="alert" className="error">
          {error}
          <button
            onClick={() => {
              setError("");
              void refreshMessages();
            }}
          >
            刷新
          </button>
        </div>
      )}
      {!ready ? (
        <div className="empty">正在连接 AI 客服…</div>
      ) : (
        <>
          {tab === "ai" && (
            <>
              <div className="welcome">{boot!.project.welcome}</div>
              <div className="presets">
                <strong>可以先问问这些问题</strong>
                <div>
                  {boot!.project.questions.map((q) => (
                    <button
                      key={q.id}
                      disabled={busy || sending}
                      onClick={() => void send(q.question)}
                    >
                      {q.question}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div
            className={
              "conversation-layout " + (tab === "tickets" ? "with-list" : "")
            }
          >
            {tab === "tickets" && (
              <aside className="ticket-list">
                <button
                  className="primary"
                  onClick={() => {
                    newChat();
                    setTab("tickets");
                    openTicket();
                  }}
                >
                  ＋ 提交工单
                </button>
                <input
                  aria-label="搜索工单"
                  placeholder="搜索已加载工单…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {tickets.length === 0 && <p className="muted">暂无咨询记录</p>}
                {tickets.map((c) => (
                  <button
                    key={c.id}
                    className={
                      "ticket-item " + (current?.id === c.id ? "active" : "")
                    }
                    onClick={() => setCurrent(c)}
                  >
                    <strong>{c.subject || "咨询工单"}</strong>
                    <small>{statusLabel[c.status] || c.status}</small>
                  </button>
                ))}
                {hasMore && (
                  <button onClick={() => void moreConversations()}>
                    加载更多咨询
                  </button>
                )}
              </aside>
            )}
            <section className="chat">
              {tab === "tickets" && !current?.ticket ? (
                <div className="empty">
                  选择一条工单查看回复，或提交新的问题。
                </div>
              ) : (
                <>
                  <div className="messages" ref={pane} aria-live="polite">
                    {cursor && (
                      <button
                        className="load-older"
                        onClick={() => void older()}
                      >
                        查看更早消息
                      </button>
                    )}
                    {messages.length === 0 && (
                      <div className="empty">
                        <span className="empty-star">✦</span>
                        <h2>有什么可以帮你？</h2>
                        <p>描述你的问题，我会在项目知识库中寻找答案。</p>
                      </div>
                    )}
                    {messages.map((m) => (
                      <article key={m.id} className={"message " + m.role}>
                        <small>
                          {m.role === "user"
                            ? "你"
                            : m.role === "assistant"
                              ? "AI 客服"
                              : "工单回复"}
                        </small>
                        <div className="bubble">
                          <Markdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              img: () => null,
                              a: ({ children, href }) => (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {m.content}
                          </Markdown>
                          {m.suggestTicket && !current?.ticket && (
                            <button onClick={openTicket}>提交工单</button>
                          )}
                        </div>
                      </article>
                    ))}
                    {busy && (
                      <div className="thinking">✦ 正在查询知识库，请稍候…</div>
                    )}
                  </div>
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send();
                    }}
                  >
                    <textarea
                      aria-label={current?.ticket ? "补充工单" : "输入问题"}
                      placeholder={
                        current?.ticket
                          ? "补充问题，客服将在工单中回复…"
                          : "输入你的问题…"
                      }
                      maxLength={8000}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-actions">
                      {!current?.ticket && (
                        <>
                          <button type="button" onClick={newChat}>
                            ＋ 新会话
                          </button>
                          <button type="button" onClick={openTicket}>
                            未解决？提交工单
                          </button>
                        </>
                      )}
                      <button
                        className="primary"
                        disabled={
                          sending || (!current?.ticket && busy) || !draft.trim()
                        }
                      >
                        {sending ? "发送中…" : "发送 ↑"}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </section>
          </div>
        </>
      )}
      {ticketOpen && (
        <div className="modal-backdrop">
          <form className="ticket-modal" onSubmit={submitTicket}>
            <div className="modal-heading">
              <h2>▤ 提交工单</h2>
              <button
                type="button"
                onClick={() => setTicketOpen(false)}
                aria-label="关闭工单弹窗"
              >
                ×
              </button>
            </div>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            <p className="muted">
              客服会根据当前对话和以下描述，在工单中回复你。
            </p>
            <label>
              问题分类
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {boot?.project.categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              问题描述
              <textarea
                required
                maxLength={8000}
                rows={5}
                placeholder="请详细描述遇到的问题，不要填写密码或 API 密钥。"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={sending || !description.trim()}
            >
              {sending ? "提交中…" : "立即提交"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
