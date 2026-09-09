# 企业微信客户 AI 客服与回访助手

企业微信员工添加客户后，为客户咨询提供 AI 自动回复，并支持人工接管、受控回访、审计与部署自动化。当前仓库已包含一个可现场演示的“微信客服”最小可用 Demo：普通微信用户可通过企业微信“微信客服”入口发送文本消息，服务端调用真实 OpenAI-compatible LLM，并将回复发回同一会话。

> 历史 Hermes 内容已保留在 [`docs/legacy/`](docs/legacy/)；当前项目以本 README 和 `specs/` 为准。

## 当前阶段重点

- **Phase 1 优先**：MySQL 持久化 + 非 RAG 核心流程 + GitHub Actions CI/CD + 单机服务器部署。
- **明确延后**：真实 RAG / 向量检索 / Dify / 个人微信协议机器人 / 大规模队列化异步处理。

## 核心能力（当前已实现）

- FastAPI 模块化单体
- SQLAlchemy 2.x async + Alembic + MySQL/SQLite
- 会话、消息、幂等、人工接管、回访计划/任务、审计日志持久化
- Fake LLM / OpenAI-compatible LLM
- 企业微信“微信客服”回调验签、AES 解密、`sync_msg` 拉取、`kf/send_msg` 文本回复
- Docker Compose（app + mysql + redis + migrate）
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
ruff check .
pytest -q
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

## GitHub Actions 配置

### Secrets

| 名称 | 说明 |
|---|---|
| `SERVER_HOST` / `SERVER_USER` | 部署服务器地址与 SSH 用户（如 `TonyAdmin`） |
| `SERVER_PASSWORD` | SSH 登录密码（配合 `sshpass` 使用） |
| `DEPLOY_PATH` | 服务器部署目录（统一为 `/opt/wecom-ai-customer-service`） |
| `LLM_API_KEY` / `EMBEDDING_API_KEY` | 模型密钥 |
| `WECOM_CORP_ID` / `WECOM_KF_SECRET` / `WECOM_TOKEN` / `WECOM_RECEIVE_ID` / `WECOM_ENCODING_AES_KEY` | 企业微信微信客服回调与 API 凭证 |

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

## 微信客服 Demo 配置与验证

> 这不是 `/docs` Swagger 页面。真实演示链路是：**微信用户 → 企业微信微信客服 → `/wecom/kf/callback` → `sync_msg` → LLM → `kf/send_msg` → 微信用户收到回复**。

### 1. 服务器 `.env` 最小必填项

```dotenv
LLM_API_KEY=你的真实模型密钥
LLM_BASE_URL=https://你的-openai-compatible-provider/v1
LLM_MODEL=gpt-4o-mini

WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_KF_SECRET=微信客服 secret
WECOM_TOKEN=企业微信后台配置的回调 Token
WECOM_RECEIVE_ID=通常填企业 CorpID；若官方页面给了独立 receive id 则填该值
WECOM_ENCODING_AES_KEY=企业微信后台配置的 43 位 EncodingAESKey
WECOM_API_BASE_URL=https://qyapi.weixin.qq.com
WECOM_HTTP_TIMEOUT_SECONDS=10
```

- 兼容旧变量名：应用仍会读取 `WECOM_SECRET` → `WECOM_KF_SECRET`、`WECOM_AES_KEY` → `WECOM_ENCODING_AES_KEY`。
- 若 `LLM_API_KEY` 留空，微信客服 Demo 会明确回复“未配置真实 AI”，不会伪装成真实大模型答案。

### 2. 企业微信管理后台配置步骤

1. 登录企业微信管理后台，进入 **微信客服**。
2. 创建或选择一个客服账号，取得 **Secret**。
3. 在 **API / 回调配置** 中填写：
   - **URL**：`https://你的域名/wecom/kf/callback`
   - **Token**：与 `WECOM_TOKEN` 保持一致
   - **EncodingAESKey**：与 `WECOM_ENCODING_AES_KEY` 保持一致
4. 保存时企业微信会发起 GET 校验；服务端会验证签名并解密 `echostr`。
5. 配置完成后，确保该域名公网可达并已启用 HTTPS。

### 3. 二维码与现场测试流程

1. 在企业微信微信客服后台生成并展示客服二维码。
2. 使用普通微信测试账号扫码进入微信客服会话。
3. 发送文本消息，例如“你好”“请介绍一下你们的产品”。
4. 服务端会收到 `kf_msg_or_event`，随后调用：
   - `GET /cgi-bin/gettoken`
   - `POST /cgi-bin/kf/sync_msg`
   - `POST /cgi-bin/kf/send_msg`
5. 微信用户应在同一客服会话里收到 AI 文本回复。

### 4. 本地 / 服务器排障

#### 健康检查

```bash
curl -i http://127.0.0.1:8000/health
```

#### Compose 配置校验

```bash
cp .env.example .env
docker compose -f docker-compose.yml config
docker compose -f docker-compose.yml -f docker-compose.ci.yml config
rm .env
```

#### 查看应用日志

```bash
docker compose logs --tail=200 app
```

日志会保留必要的排障字段（如 callback 类型、消息数量、msgid），但不会记录 access_token、secret、EncodingAESKey 或客户消息正文。

#### 手动验证回调地址可达

```bash
curl -i "https://你的域名/wecom/kf/callback?msg_signature=invalid&timestamp=1700000000&nonce=test&echostr=test"
```

预期未通过验签时返回 `4xx`，说明路由已暴露；正式联调时应由企业微信后台完成真实验签。

### 5. Demo 局限

- 当前使用 FastAPI `BackgroundTasks` 做回调后的异步处理，优先保证 MVP 简单与稳定；若进程在回调成功返回后立刻退出，后台任务可能丢失。
- 当前只支持微信客服文本消息。
- 当前仅保留基础多轮上下文，不依赖知识库/RAG。

## 手动回滚与备份

详见 [`docs/deployment.md`](docs/deployment.md)：包含 `.previous_app_image` 回滚方法、`mysqldump` 备份/恢复命令。
