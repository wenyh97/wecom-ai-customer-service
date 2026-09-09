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
  - `@grpc/grpc-js@1.13.4`（与 `wechaty-token@1.1.2` resolver listener API 兼容）
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
AI_API_BASE_URL=http://127.0.0.1:8000
AI_BRIDGE_TOKEN=与 FastAPI 保持一致
BRIDGE_MESSAGE_TIMEOUT_MS=20000
BRIDGE_API_MAX_RETRIES=1
BRIDGE_REPLY_MAX_LENGTH=500
BRIDGE_MAX_MESSAGE_AGE_SECONDS=180
BRIDGE_CONTACT_WHITELIST=
WORKPRO_AUTO_ACCEPT_FRIENDSHIP=false
WORKPRO_STAFF_USERID=
```

- 默认不要关闭 TLS。
- 试用 token、真实 LLM key、`AI_BRIDGE_TOKEN` 都不能提交。

### 本地启动 Bridge

```bash
cd bridge
cp .env.example .env
npm ci
npm run dev
```

- 必须使用 lockfile 安装（`npm ci`），不要跳过或改用 `npm install` 直接在线解析新版本。

### Compose 启动 Bridge

```bash
cp .env.example .env
docker compose up -d app mysql redis
docker compose --profile workpro up -d wechaty-bridge
docker compose --profile workpro logs -f wechaty-bridge
```

若 Bridge 曾因 resolver 异常进入重启循环，先清理旧容器，再强制拉取基础镜像并无缓存重建：

```bash
docker compose --profile workpro stop wechaty-bridge || true
docker compose --profile workpro rm -f wechaty-bridge || true
# 同步最新 main 的 bridge/ 目录
docker compose --profile workpro build --no-cache --pull wechaty-bridge
docker compose --profile workpro up wechaty-bridge
```

预期不再出现 `ERR_INVALID_ARG_TYPE` resolver callback 异常，随后进入 scan/二维码流程。

## 生产部署（Docker Compose + MySQL）

```bash
cp .env.example .env
# 填写真实密码/密钥
docker compose pull app migrate
docker compose --profile ops run --rm migrate
docker compose up -d app mysql redis
curl -f http://127.0.0.1:8000/health
```

详见 [`docs/deployment.md`](docs/deployment.md)。

## 最小验收流程

1. 获取 `WECHATY_PUPPET_SERVICE_TOKEN`
2. 配置 FastAPI 的 `LLM_*`、`AI_BRIDGE_TOKEN`
3. 配置 Bridge 的 `WECHATY_PUPPET_SERVICE_TOKEN`、`WECHATY_PUPPET_SERVICE_AUTHORITY`
4. 启动 FastAPI 与 `wechaty-bridge`
5. 用独立测试企微员工账号扫码登录
6. 普通微信外部联系人发送文本消息
7. 确认客户收到 AI 回复
8. 再发送“我刚才问了什么”，验证基础多轮上下文

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
