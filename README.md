# 企业微信客户 AI 客服与回访助手

当前 Demo 主链路已调整为：**普通微信客户 ↔ 企业微信测试员工账号 ↔ Wechaty Puppet Service WorkPro ↔ FastAPI AI 服务**。也就是说，本仓库现在优先演示“企微员工账号直接回复客户”的闭环，而不是企业微信官方“微信客服 API”方案。

> 历史 Hermes 内容已保留在 [`docs/legacy/`](docs/legacy/)；当前项目以本 README 和 `specs/` 为准。

## 当前阶段重点

- **Phase 1 优先**：MySQL 持久化 + 非知识库通用对话 + Wechaty WorkPro Bridge + GitHub Actions CI/CD + 单机服务器部署。
- **明确延后**：真实 RAG / 向量检索 / Dify / 大规模队列化异步处理。

## 核心能力（当前已实现）

- FastAPI 模块化单体
- SQLAlchemy 2.x async + Alembic + MySQL/SQLite
- 会话、消息、幂等、人工接管、回访计划/任务、审计日志持久化
- 真实 OpenAI-compatible LLM + 缺失配置时的明确诊断
- 新增 `/internal/chat`：Bridge 专用鉴权接口，按联系人隔离上下文并按 `message_id` 幂等
- 独立 `bridge/` Node.js/TypeScript Wechaty Bridge，使用 `wechaty` + `wechaty-puppet-service`
- 保留历史 `/wecom/callback` 占位/兼容代码，但它**不是**当前 Demo 的必需主链路
- Docker Compose（app + mysql + redis + migrate + 可选 workpro profile）
- GitHub Actions CI / CD 工作流

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

## 运行测试

```bash
pip install -e ".[dev]"
cd bridge && npm ci && cd ..
ruff check .
pytest -q
cd bridge && npm run lint && npm run typecheck && npm run test && cd ..
python scripts/smoke_test.py
```

## 生产部署（Docker Compose + MySQL）

```bash
cp .env.example .env
# 填写真实密码/密钥
docker compose pull app migrate
docker compose --profile ops run --rm migrate
docker compose up -d app mysql redis
curl -f http://127.0.0.1:8000/health
```

### 可选：启动 WorkPro Bridge

```bash
docker compose --profile workpro up -d wechaty-bridge
docker compose logs -f wechaty-bridge
```

> 若需要首次扫码、直接在终端展示二维码，优先使用本地 Node 方式：
>
> ```bash
> cd bridge
> cp .env.example .env
> npm ci
> npm run dev
> ```

## GitHub Actions 配置

### Secrets

| 名称 | 说明 |
|---|---|
| `SERVER_HOST` / `SERVER_USER` | 部署服务器地址与 SSH 用户（如 `TonyAdmin`） |
| `SERVER_PASSWORD` | SSH 登录密码（配合 `sshpass` 使用） |
| `DEPLOY_PATH` | 服务器部署目录（统一为 `/opt/wecom-ai-customer-service`） |
| `LLM_API_KEY` / `EMBEDDING_API_KEY` | 模型密钥 |
| `AI_BRIDGE_TOKEN` | Bridge 调用 `POST /internal/chat` 的共享密钥 |
| `WECOM_CORP_ID` / `WECOM_KF_SECRET` / `WECOM_TOKEN` / `WECOM_RECEIVE_ID` / `WECOM_ENCODING_AES_KEY` | 企业微信微信客服回调与 API 凭证 |
| `WECHATY_PUPPET_SERVICE_TOKEN` | 第三方 WorkPro Puppet Service Token（不要提交仓库） |

> 生产环境的 `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_DATABASE`、`DATABASE_URL` 统一由服务器 `/opt/wecom-ai-customer-service/.env` 管理；GitHub Actions CD 只会校验这些条目存在，并把 `APP_IMAGE` 更新为本次构建镜像，不会再覆盖整份 `.env`。
>
> CD 使用 SSH 密码登录（`sshpass -e`，密码仅通过 `SSHPASS` 环境变量传递）。**当前阶段临时关闭了 host key 校验**（`StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null`），不再需要配置 `SERVER_KNOWN_HOSTS` 或 `SERVER_SSH_KEY`，因此存在中间人攻击风险。这是首次部署的临时降级方案；部署稳定后应恢复 `StrictHostKeyChecking=yes`，并迁移到 SSH key + `known_hosts` 校验。

### Variables

`SERVER_SSH_PORT`（默认 `22`）。

应用配置（如 `APP_PORT`、`LOG_LEVEL`、`TZ`、`MYSQL_DATABASE`、`MYSQL_USER`、`DATABASE_URL`、`LLM_*`、`EMBEDDING_*`、`DEFAULT_TENANT_*`）请直接维护在服务器 `/opt/wecom-ai-customer-service/.env`。

## 观察运行状态

```bash
curl http://127.0.0.1:8000/health
docker compose logs -f app
docker compose logs -f mysql
docker compose logs -f wechaty-bridge
```

## WorkPro Demo 架构

主链路：

```text
微信客户 -> 企业微信员工账号 -> WorkPro Puppet Service -> Wechaty Bridge -> FastAPI /internal/chat -> message.say(reply) -> 微信客户收到回复
```

设计要点：

- 只做**文本私聊 MVP**
- Bridge 只使用 `contact.id`、`message.id`、企微员工账号 ID，不使用显示名做主键
- `/internal/chat` 直接调用现有 OpenAI-compatible LLM，不依赖知识库
- 通过数据库提供按联系人隔离的基础多轮上下文与 `message_id` 幂等
- Bridge 进程内按联系人串行；重启后队列状态会丢失，这是 Demo 局限

## WorkPro 配置

### 1. FastAPI `.env` 最小必填项

```dotenv
LLM_API_KEY=你的真实模型密钥
LLM_BASE_URL=https://你的-openai-compatible-provider/v1
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_SECONDS=15
AI_BRIDGE_TOKEN=仅供 bridge 使用的共享密钥
```

- 若未配置 `LLM_API_KEY`，`POST /internal/chat` 会明确返回诊断错误，不会伪装成真实 AI。
- `AI_BRIDGE_TOKEN` 必须同时配置在 FastAPI 和 Bridge 侧，但绝不能提交到仓库。

### 2. Bridge 环境变量样例

请参考 [`bridge/.env.example`](bridge/.env.example)，至少需要：

```dotenv
WECHATY_PUPPET=wechaty-puppet-service
WECHATY_PUPPET_SERVICE_TOKEN=由 WorkPro Puppet Service 提供方发放
AI_API_BASE_URL=http://127.0.0.1:8000
AI_BRIDGE_TOKEN=与 FastAPI 保持一致
BRIDGE_MESSAGE_TIMEOUT_MS=20000
BRIDGE_API_MAX_RETRIES=1
BRIDGE_REPLY_MAX_LENGTH=500
BRIDGE_MAX_MESSAGE_AGE_SECONDS=180
BRIDGE_CONTACT_WHITELIST=
```

### 3. WorkPro Token 获取说明

- `wechaty-puppet-service` 官方 npm / GitHub 用法：
  - <https://www.npmjs.com/package/wechaty-puppet-service>
  - <https://github.com/wechaty/wechaty-puppet-service>
- 本项目使用的是 **Wechaty 第三方 Puppet Service / WorkPro 方案**，**不是**企业微信官方公开 API。
- 当前试用、开通方式、定价和风控要求，请**直接向 WorkPro 服务商确认**；如果服务商页面未明确承诺，不要假定“保证有 7 天试用”。

### 4. 最小验收流程

1. 向 WorkPro 服务商取得 Token。
2. 在服务器 `.env` 和/或 `bridge/.env` 填入 `LLM_*`、`AI_BRIDGE_TOKEN`、`WECHATY_PUPPET_SERVICE_TOKEN`。
3. 启动 FastAPI：
   ```bash
   docker compose up -d app mysql redis
   ```
4. 启动 Bridge：
   ```bash
   docker compose --profile workpro up wechaty-bridge
   ```
   或本地：
   ```bash
   cd bridge && npm run dev
   ```
5. 用**独立测试企微员工账号**扫码登录。
6. 普通微信外部联系人给该员工发送“你好”。
7. 确认客户收到 AI 回复。
8. 再发送“我刚才问了什么”，验证基础多轮上下文。

### 5. 安全与合规提醒

- **不要使用核心员工账号**做 Demo，只使用独立测试员工账号。
- **不要提交 `WECHATY_PUPPET_SERVICE_TOKEN`、`AI_BRIDGE_TOKEN`、`LLM_API_KEY`**。
- WorkPro 是第三方服务，第三方**可能接触聊天元数据或消息内容**。
- 第三方 Puppet Service 依赖存在服务可用性、隐私、账号风控和平台条款风险，请自行评估。
- 默认不要关闭 TLS。若服务商当前文档要求兼容开关，再显式配置并记录风险。

### 6. 本地 / 服务器排障

#### Compose 配置校验

```bash
cp .env.example .env
docker compose -f docker-compose.yml config
docker compose -f docker-compose.yml -f docker-compose.ci.yml config
rm .env
```

#### 查看日志

```bash
docker compose logs --tail=200 app
docker compose logs --tail=200 wechaty-bridge
```

日志只保留必要排障字段（例如 `message_id`、`contact_id`、`staff_userid`、reply 长度），不会记录 Token 或完整客户消息正文。

#### 手动调用 Bridge 内部接口

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

### 7. 已知局限

- 只处理一对一文本私聊，不处理群聊、图片、文件、好友申请或营销能力。
- Bridge 采用进程内串行队列；若 Bridge 在处理时重启，队列状态不会恢复。
- 仓库中仍保留旧 `/wecom/kf/callback` 兼容实现，但它不是当前 Demo 主链路。

## 手动回滚与备份

详见 [`docs/deployment.md`](docs/deployment.md)：包含 `.previous_app_image` 回滚方法、`mysqldump` 备份/恢复命令。
