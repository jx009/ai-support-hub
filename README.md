# AI Support Hub

独立的多项目 AI 客服接入服务。MaxKB 负责知识库问答，Chatwoot 保存会话并处理用户提交的工单；本项目提供统一 API、项目配置控制台和可复用客服组件。

默认是 AI 接待。无答案或模型异常只提示提交工单，不自动替用户建单。客服在 Chatwoot 后台回复工单。

## 已实现

- 项目独立绑定 Chatwoot Account/API Inbox 与 MaxKB 应用。
- API Key + HMAC 服务端初始化，15 分钟用户令牌，项目与用户归属校验。
- 初始化包含预设问题、工单分类、品牌和欢迎语。可维护最多 30 个问题，每次初始化随机显示最多 3 个不同的已启用问题；答案统一由 MaxKB 知识库提供。
- AI 多轮问答、持久任务、按会话顺序处理、Webhook 去重、失败提示。
- Chatwoot 4.18 的回调时间戳及 HMAC 验签，回调快速入队，异步调用模型。
- 手动提工单、历史记录、补充留言、客服处理状态；不返回内部备注。
- 按钮式预设问题、Markdown 回答、手机端界面、共享 iframe 组件。
- 配置管理、连接测试、自动连接 AgentBot、预览、密钥轮换和任务重试。
- Docker 镜像、容器内数据库迁移、可选上游 Compose、原生 amd64/arm64 发布流程。

MaxKB 使用应用的兼容聊天 API。该接口未保证提供结构化引用，当前不伪造引用列表或置信度。工单分类等通过 Chatwoot 自定义属性存储，不是另一套独立工单引擎。

## 目录

```text
src/                  服务、认证、Chatwoot/MaxKB 连接、任务处理
web/                  项目配置页面与用户客服面板
public/widget.js      其他网站可直接使用的嵌入脚本
migrations/           接入配置、对象映射和任务表
deploy/               上游服务及 Nginx 示例
tests/                真实 PostgreSQL + 模拟上游协议测试、浏览器测试
.github/workflows/    CI 和多架构 Docker 发布
```

不直接修改 Chatwoot、MaxKB 或业务网站的数据库。

## 1. 部署独立客服服务

服务依赖 PostgreSQL。Chatwoot 和 MaxKB 可以使用已有部署，也可以使用下方提供的上游 Compose。

首次配置：

```bash
cd /www/ai-support-hub
node scripts/init-env.mjs --public-url=https://support.example.com
# 编辑 .env：PUBLIC_URL、SUPPORT_IMAGE、SUPPORT_IMAGE_TAG 等
```

脚本生成随机密码和密钥，不覆盖已有 .env。没有 Node 的服务器可在本地生成后通过安全方式放入服务器目录，或复制 .env.example 后填写随机值。MASTER_KEY 必须为 64 位十六进制；ADMIN_TOKEN 至少 32 字符。

### 从已发布镜像启动

例如将 .env 中的 SUPPORT_IMAGE 设置为自己的 Docker Hub 仓库，SUPPORT_IMAGE_TAG 设置为 latest 或已验证的 SHA 标签：

```bash
docker compose pull
docker compose up -d support-db
docker compose run --rm migrate
docker compose up -d support
docker compose ps
```

**同步数据库的命令是 docker compose run --rm migrate。** 该命令在镜像内运行本项目迁移，不需要服务器安装 npm、Prisma 或 TypeScript。服务启动还配置了 migrate 的完成依赖。

更新前先备份 support 数据库；更新时再次执行上面这组命令，必要时用 docker compose up -d --force-recreate support 重建应用容器。迁移报错时停止更新，保留旧镜像及数据，不删除数据卷。

### 本机或从源码构建

```bash
docker compose build
docker compose up -d
```

应用端口只绑定宿主机 127.0.0.1:6001。使用宝塔/Nginx 配置 HTTPS 反代，参见 deploy/nginx.conf.example。PUBLIC_URL 必须是浏览器与 Chatwoot 都可访问的客服根地址。已有部署需将 .env 的 SUPPORT_PORT 改为 6001，并同步修改反代目标；容器内部端口保持不变。

TRUST_PROXY_HOPS 要与反代层数一致。不要在反代给 /widget 统一加 X-Frame-Options: DENY；应用按项目域名生成 frame-ancestors。

配置页面位于 /admin，使用 .env 的 ADMIN_TOKEN 登录。该令牌仅用于平台运营配置，客服人员继续使用 Chatwoot 账号。

### 没有域名时临时通过 IP 测试

更新镜像和两个 Compose 文件后，在 `.env` 设置以下值（替换示例 IP）：

```dotenv
PUBLIC_URL=http://192.0.2.1:6001
SUPPORT_PORT=6001
SUPPORT_BIND_ADDRESS=0.0.0.0
CHATWOOT_PUBLIC_URL=http://192.0.2.1:6002
CHATWOOT_FORCE_SSL=false
TRUST_PROXY_HOPS=0
ALLOW_HTTP_UPSTREAMS=true
```

重建容器后，三个服务分别通过 IP 的 6001、6002、6003 端口访问。防火墙需允许对应访问；Chatwoot 也必须能访问客服回调。HTTP 会明文传输登录令牌和消息，仅供临时测试；HTTPS 网站无法嵌入 HTTP 客服页面。正式接入时配置 HTTPS 并恢复回环绑定、Chatwoot 强制 HTTPS 及匹配反代层数的 TRUST_PROXY_HOPS。已有项目更换 PUBLIC_URL 后需重新连接机器人以更新回调地址。

### 健康检查与日志

```bash
docker compose logs --tail=100 support
docker compose logs --tail=100 migrate
curl -f http://127.0.0.1:6001/health
```

/health 检查接入服务及其数据库，不代表已经配置好两个上游。

## 2. 可选：一并部署 Chatwoot 和 MaxKB

截至 2026-09-27，已核对以下官方镜像标签存在 amd64 和 arm64：
Chatwoot v4.18.0、MaxKB v2.10.6-lts。文件固定到这些标签，升级前需验证接口。

```bash
docker compose -f docker-compose.yml -f deploy/providers.compose.yml --profile providers pull
docker compose -f docker-compose.yml -f deploy/providers.compose.yml --profile providers up -d
```

- Chatwoot：宿主机 127.0.0.1:6002，CHATWOOT_PUBLIC_URL 配置 HTTPS 域名。
- MaxKB：宿主机 127.0.0.1:6003，单独配置 HTTPS 域名。
- Chatwoot 配套数据库是 pgvector/pgvector:pg16，Redis 与后台任务进程随 Compose 配置。
- MaxKB v2.10.6-lts 官方单容器方案挂载 /opt/maxkb，本文件已使用独立持久卷。
- Chatwoot 数据库迁移由 chatwoot-migrate 执行；它与本项目的 migrate 无关。
- 首次访问 Chatwoot 完成安装向导；MaxKB 镜像初始账号为 admin / MaxKB@123..，初始化时修改。
- Chatwoot 邀请客服通常需要 SMTP；在 .env 配置 MAILER_SENDER_EMAIL 和 SMTP_*。
- 使用容器内 HTTP 地址对接时需显式设置 ALLOW_HTTP_UPSTREAMS=true；浏览器的 PUBLIC_URL 仍用 HTTPS。

完整生产上游依赖需要对应服务器资源。本地自动测试使用协议模拟器，不能代替在自己的 Chatwoot/MaxKB 实例上配置及验收。

## 3. 配置第一个项目

1. 在 Chatwoot 新建一个 Account（工作区），给此项目添加 API 类型 Inbox。不要选择 Website Inbox：本组件通过 API 提交 incoming 消息。
2. 在该 Account 中邀请客服、设置 Administrator/Agent 和 Inbox 成员。不同项目默认使用不同 Account，避免共享联系人。
3. 在 MaxKB 创建此项目的知识库，导入资料、配置模型、发布应用，取得应用的兼容 API Base URL 和 API Key。
4. 在 /admin 新建项目，填写项目编码、Chatwoot URL、Account ID、Inbox ID、该 Account 管理员的个人 API Token，以及 MaxKB 应用配置。
5. 填写允许嵌入的网站 Origin，例如 https://callyouai.com；不带尾部斜杠和路径。添加预设问题和分类。
6. 先保持项目未启用并保存。保存刚生成的项目 API Key/Secret，Secret 只在创建或轮换时显示。
7. 点击“测试连接”，再点击“连接 AI 机器人”。系统在 Chatwoot 创建工单/邮箱属性定义，创建或更新 AgentBot、保存回调签名密钥并绑定 Inbox。客服可在 Chatwoot 用“用户提交的工单”“工单分类”等属性筛选会话。
8. 勾选“启用此项目”并保存，然后“预览客服”，发送一个问题验证真实知识库回答。

Chatwoot 必须能访问本服务 /hooks/chatwoot/... 地址。不要把该路径拦在额外的网页登录页之后。机器人 Secret 若在 Chatwoot 被重置，需重新点击连接。

### 避免上游故障自动进入人工队列

Chatwoot 4.18 在机器人回调失败时，默认可能将 pending 会话改成 open。要严格保持“用户提交工单才由人工处理”，应对每个专用 Account 设置 keep_pending_on_bot_failure：

```bash
# 把 1 替换为该项目的 Chatwoot Account ID
docker compose -f docker-compose.yml -f deploy/providers.compose.yml --profile providers run --rm chatwoot \
  bundle exec rails runner 'Account.find(1).update!(keep_pending_on_bot_failure: true)'
```

这是 Chatwoot Account 的 settings 字段，不是本项目数据库字段。即使上游异常改变了状态，本项目仍只将有 support_ticket 标记的会话展示为用户工单。

## 4. 接入 LetAiCode

当前 LetAiCode 已增加：

- 超级管理员菜单“AI 客服接入”：/admin/support-hub。
- 登录用户右下角“联系客服”按钮。
- “向所有人显示客服入口”开关默认关闭，此时只有管理员和超级管理员可见并使用。开启后访客也能看到入口，点击后先登录；“启用客服服务”总开关关闭时对所有人停用。
- 服务端签名初始化，用户 ID/邮箱来自真实登录态。
- 对 iframe 的来源和发送窗口校验；短期令牌只在内存传递。
- 客服聊天、历史工单和提交表单使用 LetAiCode 的字体、字号、背景、文字、边框及主色变量，跟随网站实时切换深浅模式，不重置对话或草稿。需要同时更新 LetAiCode 前端与客服服务镜像，无需数据库迁移。
- 服务端 Option 加密保存项目 Secret；不新增业务数据库表。
- 原有 Docker/GitHub Actions 的路径检测会构建新增后端和前端代码。

在 LetAiCode 管理界面保存本服务地址、项目编码、API Key、Secret，启用并测试。也可先通过其 Docker 环境变量提供默认配置：

```dotenv
SUPPORT_HUB_ENABLED=true
SUPPORT_HUB_SHOW_TO_ALL=false
SUPPORT_HUB_URL=https://support.example.com
SUPPORT_HUB_PROJECT_CODE=letaicode
SUPPORT_HUB_API_KEY=项目APIKey
SUPPORT_HUB_API_SECRET=项目Secret
```

后台保存的配置优先于环境默认值。原站数据库不用为此次接入执行 Prisma 迁移。

## 5. 其他网站接入

自行嵌入 iframe 时，可以在 `support:init` 消息中附带可选的 `theme: { mode: 'light' | 'dark', tokens: {...} }`。`tokens` 为 CSS 变量名（不含 `--`）到已解析值的映射，例如 `primary-color`、`bg-container`、`text-primary`、`font-family`、`font-size`，完整允许列表见 `web/theme.ts`。省略主题时仍使用默认样式及项目主色。

切换主题时向同一个 iframe 发送 `{ type: 'support:theme', theme }`，目标 origin 必须是客服服务的 origin。组件仅接受已初始化的父窗口和接入来源发送的主题消息；主题更新不会重新初始化会话。每次主题消息应包含完整的自定义 tokens，省略项恢复默认值。通用 `/widget.js` 嵌入脚本目前仍使用默认主题，LetAiCode 使用自己的主题同步组件。

### 网站后端：签名初始化

只允许网站自己验证过的登录用户触发此请求；user.id、email 不能直接从前端请求正文取值。

```js
import crypto from "node:crypto";

async function bootstrapSupport(user) {
  const path = "/support/v1/bootstrap";
  const body = JSON.stringify({
    projectCode: process.env.SUPPORT_PROJECT_CODE,
    externalUserId: user.id,
    email: user.email,
    name: user.name || "",
    origin: "https://your-site.example",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(20).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const signature = crypto
    .createHmac("sha256", process.env.SUPPORT_API_SECRET)
    .update(["POST", path, timestamp, nonce, bodyHash].join("\n"))
    .digest("hex");
  const response = await fetch(process.env.SUPPORT_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Support-Key": process.env.SUPPORT_API_KEY,
      "X-Support-Timestamp": timestamp,
      "X-Support-Nonce": nonce,
      "X-Support-Signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error("客服初始化失败");
  return response.json();
}
```

nonce 一次有效，时间窗口 5 分钟。签名使用实际发送的原始 JSON 字节，路径为完整 /support/v1/bootstrap。

### 网站前端：共享组件

引入服务根目录的 /widget.js，并在已登录页面的应用代码中执行：

```js
const support = window.SupportHub.mount({
  baseUrl: "https://support.example.com",
  bootstrap: async () => {
    // 此接口属于业务网站，由该网站后端调用上面的签名函数。
    const response = await fetch("/your-backend/support-bootstrap", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("请登录后使用客服");
    return response.json();
  },
  onError: (error) => console.error(error.message),
});
// 登出或切换用户时：
support.destroy();
```

不要把项目 Secret 放到浏览器。bootstrap 回调在令牌到期前会被再次调用。使用 API 自建界面时，初始化后的令牌放在 Authorization: Bearer 中，同时带 X-Embed-Origin。写操作需要 Idempotency-Key；同一个键不能改写成另一条内容。

## 6. GitHub Actions

采用 modelshot-code 的原生双架构思路：

- amd64：ubuntu-latest；
- arm64：ubuntu-24.04-arm；
- 两边独立缓存、构建和推送临时标签；最终合并 manifest；
- 验收测试通过后才发布；
- main 发布 latest，develop 发布 test-latest，另外保留 SHA/版本标签；
- npm ci 使用提交的 package-lock.json；
- 不在镜像构建时连接生产数据库。

GitHub 仓库配置：

| 类型                    | 名称                                        |
| ----------------------- | ------------------------------------------- |
| Variable                | DOCKERHUB_IMAGE，例如 jxthdy/ai-support-hub |
| Secret                  | DOCKERHUB_USERNAME、DOCKERHUB_TOKEN         |
| 兼容现有 LetAiCode 名称 | DOCKER_USERNAME、DOCKER_PASSWORD            |

新项目已有本地 Git 仓库，但没有替你创建 GitHub 仓库或配置远程 Secrets。把它推到独立仓库后，Actions 才能在该仓库运行；工作流负责发布镜像，不会自动修改线上服务器。

## 7. 本地开发与验收

```bash
npm ci
# 使用仅供本项目测试的 PostgreSQL
docker run -d --name ai-support-hub-test-db -p 127.0.0.1:55439:5432 \
  -e POSTGRES_USER=support_test -e POSTGRES_PASSWORD=local-support-tests-only \
  -e POSTGRES_DB=support_test postgres:16-alpine

npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

可通过 TEST_DATABASE_URL 改测试地址，但数据库名必须以 _test 结尾。测试会清空该测试数据库中的项目数据，勿指定业务库。

本地 API 开发使用 DATABASE_URL、MASTER_KEY、ADMIN_TOKEN、PUBLIC_URL 等环境配置，先 npm run migrate，再 npm run dev；前端 npm run dev:web。浏览器验收以构建后的同源服务为准。

验证覆盖项目/用户隔离、签名重放、凭证加密、幂等、项目知识库选择、多轮上下文、AI 失败不自动提单、人工标记、内部备注过滤、迟到 AI 回复抑制及浏览器操作。

## 8. 运维边界

- MASTER_KEY 用于加密持久化凭证，备份时和数据分别安全保存；不能随意替换，否则已存凭证无法解密。
- 升级或停机时任务持久化在 PostgreSQL；中断的 running 任务超过租约后会恢复。
- 写入响应不确定时先按远端消息标记查重，不盲目重复发送。
- 模型失败返回明确提示和提单入口，不假造知识库结果。
- AI 消息发布与工单切换互斥；工单建立后不会发送迟到的 AI 回复。
- 消息正文以 Chatwoot 为准；本项目只保存映射及必要任务结果。
- 完整生产联调需要真实上游地址、凭证、模型及知识文档；本地协议模拟测试不等于已完成生产部署。

## 官方接口核对资料

- Chatwoot AgentBot 文档：https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots
- Chatwoot API 分类：https://developers.chatwoot.com/api-reference/introduction
- Chatwoot v4.18.0 源码：Account/AgentBot/消息接口、Webhook HMAC 与状态处理。
- MaxKB 应用兼容 API：https://maxkb.cn/docs/v2/user_manual/chat_to_API.html
- MaxKB v2.10.6-lts README：官方镜像单容器部署与 /opt/maxkb 持久化路径。
