# 企业微信客户 AI 客服与回访助手

当前 Demo 主链路：

```text
普通微信客户 ↔ 企业微信测试员工账号 ↔ JuziBot WorkPro Puppet Service ↔ Wechaty Bridge ↔ FastAPI /internal/chat ↔ LLM
```

> 历史 Hermes 内容保留在 [`docs/legacy/`](docs/legacy/)；当前实现以本 README、`docs/` 和 `specs/` 为准。

## 当前阶段重点

- **Phase 1**：MySQL 持久化、真实 OpenAI-compatible LLM、多轮上下文、`/internal/chat`、Wechaty WorkPro Bridge、CI/CD、单机部署
- **明确延后**：真实 RAG / 向量检索 / Dify / 大规模异步队列

## 核心能力

- FastAPI 模块化单体
- SQLAlchemy 2.x async + Alembic + MySQL/SQLite
- 会话、消息、幂等、人工接管、回访计划/任务、审计日志持久化
- `/internal/chat`：Bridge 专用内部接口，带 ****** 和 `message_id` 幂等
- 独立 `bridge/` Node.js/TypeScript Wechaty Bridge
- Bridge 运行时 Node 版本：`20.x` / `22.x` LTS（Docker 基础镜像固定为 `node:22-bookworm-slim`）
- Bridge 运行时固定使用：
  - `@juzi/wechaty`
  - `@juzi/wechaty-puppet-service`
  - `@grpc/grpc-js@1.13.5`
  - `wechaty-token@1.1.2` + 仓库内 `bridge/src/grpc-resolver-compat.ts` 兼容层：把 token discovery 返回的 `{host, port}` 包装成 `grpc-js@1.13.5` 需要的 endpoint list，并在 discovery 返回空/非法地址时走 `onError`
  - `puppet: '@juzi/wechaty-puppet-service'`
  - `WECHATY_PUPPET_SERVICE_AUTHORITY=token-service-discovery-test.juzibot.com`
- Bridge 安全策略：
  - `error` 日志脱敏
  - `friendship` 默认不自动接受；仅 `WORKPRO_AUTO_ACCEPT_FRIENDSHIP=true` 且 `Receive` 时 accept
  - `room-join` 仅审计，不发消息
  - 群消息、自发消息、非文本消息、过期消息忽略
  - 按 `message.id` 去重，按联系人串行处理
- 历史 `/wecom/callback` / `/chat/messages` 兼容代码仍保留，但**不是**当前 Demo 主链路

## 快速开始（本地 SQLite）

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:app --reload --app-dir src
```

如需无外部依赖测试，可将 `DATABASE_URL` 设为 `sqlite+aiosqlite:///:memory:`。

## 数据库迁移

```bash
alembic upgrade head
```

> 应用启动不会自动建表；部署时必须先执行迁移。

## 运行验证

```bash
pip install -e ".[dev]"
cd bridge && npm ci && cd ..
ruff check .
pytest -q
cd bridge && npm run lint && npm run typecheck && npm run test && cd ..
cp .env.example .env
docker compose -f docker-compose.yml config
docker compose -f docker-compose.yml -f docker-compose.ci.yml config
rm .env
python scripts/smoke_test.py
```

## WorkPro / Wechaty Bridge 配置

### FastAPI `.env` 最小必填项

```dotenv
LLM_API_KEY=你的真实模型密钥
LLM_BASE_URL=https://你的-openai-compatible-provider/v1
LLM_MODEL=gpt-4o-mini
LLM_AUTH_MODE=bearer
LLM_SEND_TEMPERATURE=true
LLM_TIMEOUT_SECONDS=15
AI_BRIDGE_TOKEN=仅供 bridge 使用的共享密钥
```

- 若未配置 `LLM_API_KEY`，`POST /internal/chat` 会明确返回诊断错误。
- `LLM_AUTH_MODE` 默认 `bearer`（发送 `Authorization` 头）；Azure OpenAI 需改为 `api-key`（发送 `api-key` 头）。
- `LLM_SEND_TEMPERATURE` 默认 `true`，保持通用 OpenAI-compatible provider 行为；若目标 Azure / 推理模型不接受 `temperature` 字段，请显式设为 `false`。
- `AI_BRIDGE_TOKEN` 必须同时配置在 FastAPI 和 Bridge 侧，但绝不能提交仓库。

Azure OpenAI 示例：

```dotenv
LLM_BASE_URL=https://你的资源名.openai.azure.com/openai/v1/
LLM_MODEL=gpt-5.6-luna
LLM_AUTH_MODE=api-key
LLM_SEND_TEMPERATURE=false
```

### Bridge `.env` 关键项

请参考 [`bridge/.env.example`](bridge/.env.example)：

```dotenv
WECHATY_PUPPET_SERVICE_TOKEN=由 JuziBot / WorkPro 服务商发放
WECHATY_PUPPET_SERVICE_AUTHORITY=token-service-discovery-test.juzibot.com
WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_CLIENT=true
AI_API_BASE_URL=http://127.0.0.1:8000
AI_BRIDGE_TOKEN=与 FastAPI 保持一致
BRIDGE_WEB_HOST=127.0.0.1
BRIDGE_WEB_PORT=18080
BRIDGE_WEB_TOKEN=至少 16 位随机共享访问令牌
BRIDGE_WEB_SESSION_TTL_MS=43200000
BRIDGE_WEB_VERIFY_TIMEOUT_MS=300000
BRIDGE_MESSAGE_TIMEOUT_MS=20000
BRIDGE_API_MAX_RETRIES=1
BRIDGE_REPLY_MAX_LENGTH=500
BRIDGE_MAX_MESSAGE_AGE_SECONDS=180
BRIDGE_CONTACT_WHITELIST=
WORKPRO_AUTO_ACCEPT_FRIENDSHIP=false
WORKPRO_STAFF_USERID=
```

- 当前 JuziBot 试用 discovery 返回的 `101.126.67.87:4001` 为明文 gRPC 端口，生产运行需显式设置 `WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_CLIENT=true`；本仓库不会替你在代码中偷偷改掉该行为。
- Web 控制台默认地址为 `http://127.0.0.1:18080/`（本地直接运行时）；验证码输入只通过受保护的 `POST /api/verify-code` 提交，不会拼接到 URL。
- Web 控制台提供「企微智能助手管理后台」：登录页用户名固定为 `admin`，密码校验沿用运行时 `BRIDGE_WEB_TOKEN`（通过 `/api/session` 建立会话），不在前端硬编码密码。
- 后台聚焦企业微信接入管理，侧边栏实时展示当前登录状态与账号；二维码、扫码状态和验证码提交均走现有 Bridge 控制接口。
- 试用 token、真实 LLM key、`AI_BRIDGE_TOKEN` 都不能提交。

### 本地启动 Bridge

```bash
cd bridge
cp .env.example .env
npm ci
set -a
. ./.env
set +a
npm run dev
```

- 必须使用 lockfile 安装（`npm ci`），不要跳过或改用 `npm install` 直接在线解析新版本。
- 首次启动建议保持前台运行以观察日志，但扫码和验证码输入改为在浏览器控制台完成，不再依赖 SSH 终端输入。
- 本次二阶段 resolver 根因不是 callback 是否存在，而是 `wechaty-token` 旧 resolver 把 `TcpSubchannelAddress[]` 直接传给了 `grpc-js@1.13.5` 已切换到 endpoint-list 语义的 `onSuccessfulResolution(...)`。验收标准必须是 **不再出现 `ERR_INVALID_ARG_TYPE` / `Cannot use 'in' operator to search for 'port' in undefined`，并继续进入 scan/二维码流程**。

### Compose 启动 Bridge

```bash
cp .env.example .env
docker compose up -d app mysql redis
docker compose --profile workpro up --no-build --no-deps wechaty-bridge
docker compose --profile workpro logs -f wechaty-bridge
```

> 上述命令主要用于本地或手动排障。生产环境的 main 分支 CD 现已自动构建、推送并部署 app 与 `wechaty-bridge` 镜像；服务器不再需要手动同步 `bridge/`、手动 `docker compose build` 或手动重启 Bridge。

推荐先建立 SSH 隧道，再在本地浏览器打开控制台：

```bash
ssh -L 18080:127.0.0.1:18080 TonyAdmin@服务器
```

然后在本地浏览器访问：

```text
http://127.0.0.1:18080/
```

> `docker-compose.yml` 默认把宿主机暴露地址限制为 `127.0.0.1:${BRIDGE_WEB_PORT}`，仅供 SSH 隧道或服务器本机访问；不要直接把控制台端口发布到公网。

若 Bridge 曾因 resolver 异常进入重启循环，先清理旧容器，再强制拉取基础镜像并无缓存重建：

```bash
docker compose --profile workpro stop wechaty-bridge || true
docker compose --profile workpro rm -f wechaty-bridge || true
# 仅在本地源码排障时才需要重新 build；生产 CD 已改为直接拉取 GHCR Bridge 镜像
docker compose --profile workpro build --no-cache --pull wechaty-bridge
docker compose --profile workpro up --no-build --no-deps wechaty-bridge
```

重建后先验证镜像内运行时状态，再看启动日志：

```bash
docker compose --profile workpro run --rm --entrypoint sh wechaty-bridge -lc \
  'node -v && npm ls @grpc/grpc-js wechaty-token --depth=0 && test -f dist/src/grpc-resolver-compat.js'
```

预期：

- Node 为 `22.x`
- `@grpc/grpc-js` 为 `1.13.5`
- `wechaty-token` 为 `1.1.2`
- 兼容层已编译进镜像
- 启动日志不再出现 `ERR_INVALID_ARG_TYPE` 或 `Cannot use '\''in'\'' operator to search for '\''port'\'' in undefined`
- 本地浏览器能看到二维码；扫码后如需验证码，页面会出现输入框；提交成功后日志继续出现 `login` / `ready`
- Bridge 继续进入 scan/二维码流程，而不是只启动几秒

## 生产部署（Docker Compose + MySQL）

```bash
cp .env.example .env
# 填写真实密码/密钥；APP_IMAGE / BRIDGE_IMAGE 由 CD 自动维护
docker compose pull app migrate
docker compose pull mysql redis
docker compose --profile ops run --rm migrate
docker compose up -d --no-build app mysql redis
curl -f http://127.0.0.1:8000/health
```

详见 [`docs/deployment.md`](docs/deployment.md)。

### main 分支 CD 自动交付

- CD 会同时构建并推送：
  - `ghcr.io/<owner>/wecom-ai-customer-service:sha-<commit>` / `:latest`
  - `ghcr.io/<owner>/wecom-ai-customer-service-bridge:sha-<commit>` / `:latest`
- CD 会原子更新服务器 `.env` 中的 `APP_IMAGE` 与 `BRIDGE_IMAGE`，保留其他 secrets 不变。
- 服务器只需维护真实配置，不再需要手动同步 `bridge/` 源码或执行 `docker compose build`。
- `DEPLOY_WORKPRO=true` 时，CD 会额外拉取并以 `--no-build --force-recreate --no-deps` 更新 `wechaty-bridge`；未启用时会清晰记录 `WorkPro disabled`，仍继续部署 app。
- `DEPLOY_WORKPRO=true` 时请确保服务器 `.env` 至少已配置：`WECHATY_PUPPET_SERVICE_TOKEN`、`AI_BRIDGE_TOKEN`、`BRIDGE_WEB_TOKEN`。这些值不会打印到 GitHub Actions 日志。

CD 后可在服务器验证：

```bash
cd /opt/wecom-ai-customer-service
docker compose ps
docker compose --profile workpro ps
curl -f http://127.0.0.1:8000/health
curl -f http://127.0.0.1:18080/health
```

通过 SSH 隧道访问 Bridge Web 控制台：

```bash
ssh -L 18080:127.0.0.1:18080 TonyAdmin@服务器
```

然后在本地浏览器打开 `http://127.0.0.1:18080/`。默认仅绑定服务器 `127.0.0.1`，**不要直接暴露到公网**。Bridge 重启后可能需要重新扫码或输入验证码；首次登录建议不要后台隐藏日志，先观察 `docker compose --profile workpro logs -f wechaty-bridge`。

## 最小验收流程

1. 获取 `WECHATY_PUPPET_SERVICE_TOKEN`
2. 配置 FastAPI 的 `LLM_*`、`AI_BRIDGE_TOKEN`
3. 配置 Bridge 的 `WECHATY_PUPPET_SERVICE_TOKEN`、`WECHATY_PUPPET_SERVICE_AUTHORITY`
4. 启动 FastAPI 与 `wechaty-bridge`
5. 通过 SSH 隧道或服务器本机浏览器打开 `http://127.0.0.1:${BRIDGE_WEB_PORT:-18080}/`
6. 确认 Bridge 日志未出现两类 resolver 异常，且页面已显示二维码
7. 用独立测试企微员工账号扫码登录；如页面提示验证码，则在页面输入并提交，不要把验证码贴到日志、聊天或仓库
8. 等待日志出现 `login` / `ready`
9. 普通微信外部联系人发送文本消息
10. 确认客户收到 AI 回复
11. 再发送“我刚才问了什么”，验证基础多轮上下文

## GitHub Actions 配置

### Secrets

| 名称 | 说明 |
|---|---|
| `SERVER_HOST` / `SERVER_USER` | 部署服务器地址与 SSH 用户 |
| `SERVER_PASSWORD` | SSH 登录密码 |
| `DEPLOY_PATH` | 部署目录，统一为 `/opt/wecom-ai-customer-service` |
| `LLM_API_KEY` / `EMBEDDING_API_KEY` | 模型密钥 |
| `AI_BRIDGE_TOKEN` | Bridge 调用 `POST /internal/chat` 的共享密钥 |
| `WECOM_CORP_ID` / `WECOM_KF_SECRET` / `WECOM_TOKEN` / `WECOM_RECEIVE_ID` / `WECOM_ENCODING_AES_KEY` | 历史企业微信回调兼容凭证 |
| `WECHATY_PUPPET_SERVICE_TOKEN` | 第三方 WorkPro Puppet Service Token |

### CI 覆盖

- `ruff check .`
- `pytest -q`
- `cd bridge && npm run lint`
- `cd bridge && npm run typecheck`
- `cd bridge && npm run test`
- `docker compose -f docker-compose.yml config`
- `docker compose -f docker-compose.yml -f docker-compose.ci.yml config`

## 运行观察与排障

```bash
curl http://127.0.0.1:8000/health
docker compose logs --tail=200 app
docker compose logs --tail=200 wechaty-bridge
```

手动调用 Bridge 内部接口：

```bash
AUTH_HEADER="$(printf '%s: %s %s' Authorization Bearer "$AI_BRIDGE_TOKEN")"
curl -i \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8000/internal/chat \
  -d '{
    "conversation_key":"wechaty-workpro:staff-1:contact-1",
    "contact_id":"contact-1",
    "staff_userid":"staff-1",
    "message_id":"msg-1",
    "text":"你好"
  }'
```

日志只保留必要排障字段，不记录 Token 或完整客户消息正文。

## 安全与合规提醒

- 不要提交真实 `WECHATY_PUPPET_SERVICE_TOKEN`、`AI_BRIDGE_TOKEN`、`LLM_API_KEY`
- 不要提交截图、客户数据或其他敏感信息
- 只使用独立测试员工账号做 Demo，不要使用核心员工账号
- WorkPro 是第三方 Puppet Service，不是企业微信官方公开 API
- 第三方服务可能接触消息元数据或内容，存在可用性、隐私、账号风控和平台条款风险

## 已知局限

- 只处理一对一文本私聊，不处理群聊、图片、文件、营销能力
- Bridge 采用进程内串行队列；处理中重启不会恢复队列
- 旧 `/wecom/callback` 兼容实现仍存在，但不是当前演示主链路
