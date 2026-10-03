import React, { useState, useEffect, useRef } from "react";
import type { Bootstrap } from "./types";
const originOf = (value: string) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
};
const empty = {
  code: "",
  name: "",
  enabled: false,
  settings: {
    chatwootUrl: "",
    accountId: 1,
    inboxId: 1,
    chatwootToken: "",
    maxkbUrl: "",
    maxkbKey: "",
    model: "maxkb",
    origins: [] as string[],
    welcome: "你好，我是 AI 客服。你可以先向我提问，未解决的问题可提交工单。",
    color: "#4f46e5",
    questions: [] as any[],
    categories: [
      { code: "general", name: "一般咨询" },
      { code: "technical", name: "技术问题" },
      { code: "billing", name: "账单问题" },
    ],
    systemPrompt:
      "请根据知识库用中文回答。没有依据时明确说明，并建议用户提交工单。",
  },
};
export default function Admin() {
  const [token, setToken] = useState(""),
    [logged, setLogged] = useState(false),
    [projects, setProjects] = useState<any[]>([]),
    [form, setForm] = useState<any>(structuredClone(empty));
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false),
    [secret, setSecret] = useState(""),
    [jobs, setJobs] = useState<any[]>([]);
  const [questions, setQuestions] = useState(""),
    [origins, setOrigins] = useState(""),
    [categories, setCategories] = useState(
      "general|一般咨询\ntechnical|技术问题\nbilling|账单问题",
    );
  const [preview, setPreview] = useState<Bootstrap | null>(null),
    frame = useRef<HTMLIFrameElement>(null);
  async function api(path: string, method = "GET", body?: unknown) {
    const r = await fetch("/admin/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "请求失败");
    return d;
  }
  async function load() {
    setProjects(await api("/projects"));
  }
  function choose(p: any) {
    setForm(structuredClone(p));
    setSecret("");
    setNotice("");
    setQuestions(p.settings.questions.map((q: any) => q.question).join("\n"));
    setOrigins(p.settings.origins.join("\n"));
    setCategories(
      p.settings.categories.map((c: any) => c.code + "|" + c.name).join("\n"),
    );
  }
  async function action(fn: () => Promise<void>) {
    setSaving(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function settings(k: string, v: any) {
    setForm((f: any) => ({ ...f, settings: { ...f.settings, [k]: v } }));
  }
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (
        !preview ||
        e.source !== frame.current?.contentWindow ||
        e.origin !== location.origin
      )
        return;
      if (e.data?.type === "support:ready")
        frame.current?.contentWindow?.postMessage(
          { type: "support:init", bootstrap: preview },
          location.origin,
        );
      if (e.data?.type === "support:refresh")
        void api("/projects/" + form.id + "/preview", "POST")
          .then(setPreview)
          .catch((e) => setError(e.message));
      if (e.data?.type === "support:close") setPreview(null);
    };
    window.addEventListener("message", listener);
    if (preview)
      frame.current?.contentWindow?.postMessage(
        { type: "support:init", bootstrap: preview },
        location.origin,
      );
    return () => window.removeEventListener("message", listener);
  }, [preview, form.id, token]);
  const save = async () => {
    const body = {
      ...form,
      settings: {
        ...form.settings,
        origins: origins
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        questions: questions
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((q, i) => ({ id: "q-" + i, question: q, enabled: true })),
        categories: categories
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => {
            const [code, ...rest] = x.split("|");
            return { code: code.trim(), name: rest.join("|").trim() };
          }),
      },
    };
    const result = await api(
      "/projects" + (form.id ? "/" + form.id : ""),
      form.id ? "PUT" : "POST",
      body,
    );
    choose(result);
    if (result.apiSecret) setSecret(result.apiSecret);
    setNotice("配置已保存。新项目请先连接机器人，再启用并预览。");
    await load();
  };
  if (!logged)
    return (
      <main className="admin-login">
        <div className="brand-icon">✦</div>
        <h1>AI 客服平台</h1>
        <p>项目配置 · MaxKB 知识库 · Chatwoot 工单</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await load();
              setLogged(true);
            });
          }}
        >
          <label>
            管理令牌
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="服务器 ADMIN_TOKEN"
            />
          </label>
          <button className="primary" disabled={saving}>
            进入项目管理
          </button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <p className="muted">工单客服请登录 Chatwoot；这里仅维护接入配置。</p>
      </main>
    );
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <h2>✦ AI 客服平台</h2>
        <p className="muted">一个入口，服务多个项目</p>
        <button
          className="primary"
          onClick={() => choose(structuredClone(empty))}
        >
          ＋ 新增项目
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            className={"project-item " + (form.id === p.id ? "active" : "")}
            onClick={() => choose(p)}
          >
            <strong>{p.name}</strong>
            <small>
              {p.code} · {p.enabled ? "已启用" : "未启用"}
            </small>
          </button>
        ))}
        <button
          onClick={() => {
            setToken("");
            setLogged(false);
            setPreview(null);
            setSecret("");
          }}
        >
          退出管理
        </button>
      </aside>
      <main className="admin-content">
        <header>
          <h1>{form.id ? form.name : "新增客服项目"}</h1>
          <p>默认由 AI 回答；用户提交工单后，客服才介入处理。</p>
          <div className="external-links">
            {originOf(form.settings.maxkbUrl) && (
              <a
                href={originOf(form.settings.maxkbUrl)}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 MaxKB 维护知识库 ↗
              </a>
            )}
            {originOf(form.settings.chatwootUrl) && (
              <a
                href={
                  originOf(form.settings.chatwootUrl) +
                  "/app/accounts/" +
                  form.settings.accountId +
                  "/dashboard"
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 Chatwoot 处理工单 ↗
              </a>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {notice && <div className="success">{notice}</div>}
        {secret && (
          <div className="secret-box">
            <strong>请立即保存 API Secret，仅本次显示</strong>
            <input readOnly value={secret} onFocus={(e) => e.target.select()} />
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(save);
          }}
          className="project-form"
        >
          <section>
            <h2>项目与接入</h2>
            <div className="grid">
              <label>
                项目名称
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                项目编码
                <input
                  required
                  disabled={!!form.id}
                  pattern="[a-z][a-z0-9_-]{1,49}"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
            </div>
            <label>
              允许嵌入的网站 Origin（每行一个，不带路径）
              <textarea
                required
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                placeholder="https://callyouai.com"
              />
            </label>
            {form.apiKey && (
              <label>
                API Key
                <input readOnly value={form.apiKey} />
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              启用此项目
            </label>
          </section>
          <section>
            <h2>MaxKB · AI 知识库</h2>
            <p className="muted">
              在 MaxKB 为每个项目创建独立应用；填写应用概览中的兼容 API Base
              URL。
            </p>
            <label>
              应用 Base URL
              <input
                type="url"
                required
                value={form.settings.maxkbUrl}
                onChange={(e) => settings("maxkbUrl", e.target.value)}
              />
            </label>
            <div className="grid">
              <label>
                应用 API Key
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={form.id ? "留空保持已保存值" : ""}
                  value={form.settings.maxkbKey}
                  onChange={(e) => settings("maxkbKey", e.target.value)}
                />
              </label>
              <label>
                模型字段
                <input
                  required
                  value={form.settings.model}
                  onChange={(e) => settings("model", e.target.value)}
                />
              </label>
            </div>
            <label>
              回答要求
              <textarea
                value={form.settings.systemPrompt}
                onChange={(e) => settings("systemPrompt", e.target.value)}
              />
            </label>
          </section>
          <section>
            <h2>Chatwoot · 消息与工单</h2>
            <label>
              服务地址
              <input
                type="url"
                required
                value={form.settings.chatwootUrl}
                onChange={(e) => settings("chatwootUrl", e.target.value)}
              />
            </label>
            <div className="grid">
              <label>
                Account ID
                <input
                  type="number"
                  min="1"
                  value={form.settings.accountId}
                  onChange={(e) =>
                    settings("accountId", Number(e.target.value))
                  }
                />
              </label>
              <label>
                API Inbox ID
                <input
                  type="number"
                  min="1"
                  value={form.settings.inboxId}
                  onChange={(e) => settings("inboxId", Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              该 Account 的管理员 API Token
              <input
                type="password"
                autoComplete="off"
                placeholder={form.id ? "留空保持已保存值" : ""}
                value={form.settings.chatwootToken}
                onChange={(e) => settings("chatwootToken", e.target.value)}
              />
            </label>
            <p className="muted">
              客服账号及项目成员权限在 Chatwoot 内管理。每个项目绑定不同
              Account。
            </p>
            {form.settings.botId && <p>已连接机器人 #{form.settings.botId}</p>}
          </section>
          <section>
            <h2>客服入口内容</h2>
            <label>
              欢迎语
              <textarea
                value={form.settings.welcome}
                onChange={(e) => settings("welcome", e.target.value)}
              />
            </label>
            <label>
              预设问题（每行一个，初始化自动下发）
              <textarea
                rows={5}
                value={questions}
                onChange={(e) => setQuestions(e.target.value)}
                placeholder="API Key 在哪里创建？"
              />
            </label>
            <label>
              工单分类（每行：编码|名称）
              <textarea
                rows={4}
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
              />
            </label>
            <label>
              主题色
              <input
                type="color"
                value={form.settings.color}
                onChange={(e) => settings("color", e.target.value)}
              />
            </label>
          </section>
          <div className="admin-actions">
            <button className="primary" disabled={saving}>
              保存配置
            </button>
            {form.id && (
              <>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void action(async () => {
                      const r = await api(
                        "/projects/" + form.id + "/test",
                        "POST",
                      );
                      setNotice(r.maxkb + "；Chatwoot 连接正常");
                    })
                  }
                >
                  测试连接
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void action(async () => {
                      const r = await api(
                        "/projects/" + form.id + "/connect",
                        "POST",
                      );
                      settings("botId", r.botId);
                      setNotice("机器人已连接，请保存启用状态并预览。");
                      await load();
                    })
                  }
                >
                  连接 AI 机器人
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void action(async () =>
                      setPreview(
                        await api("/projects/" + form.id + "/preview", "POST"),
                      ),
                    )
                  }
                >
                  预览客服
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    if (
                      window.confirm(
                        "轮换后旧 Secret 立即失效，请同步更新接入网站。",
                      )
                    )
                      void action(async () => {
                        const r = await api(
                          "/projects/" + form.id + "/rotate",
                          "POST",
                        );
                        setSecret(r.apiSecret);
                      });
                  }}
                >
                  轮换接入密钥
                </button>
              </>
            )}
          </div>
        </form>
        <section className="jobs">
          <h2>AI 处理任务</h2>
          <button
            onClick={() => void action(async () => setJobs(await api("/jobs")))}
          >
            刷新记录
          </button>
          {jobs.map((j) => (
            <div className="job" key={j.id}>
              <span>{j.project}</span>
              <span>
                {j.state} · {j.attempts} 次
              </span>
              <span>{j.error}</span>
              {j.state === "failed" && (
                <button
                  onClick={() =>
                    void action(async () => {
                      await api("/jobs/" + j.id + "/retry", "POST");
                      setJobs(await api("/jobs"));
                    })
                  }
                >
                  重试
                </button>
              )}
            </div>
          ))}
        </section>
      </main>
      {preview && (
        <div className="modal-backdrop">
          <div className="preview">
            <button className="preview-close" onClick={() => setPreview(null)}>
              关闭预览 ×
            </button>
            <iframe
              ref={frame}
              title="客服预览"
              src={"/widget?project=" + preview.project.code}
            />
          </div>
        </div>
      )}
    </div>
  );
}
