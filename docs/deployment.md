# 部署文档

## 1. 前提

服务器需具备：

- Docker Engine
- Docker Compose v2（`docker compose`）
- 可执行 `docker compose`、`curl` 的 SSH 用户（本项目为 `TonyAdmin`，需加入 `docker` 组以具备执行 docker 的权限）
- 允许 SSH 密码登录（`sshd_config` 中 `PasswordAuthentication yes`）
- 部署目录 `/opt/wecom-ai-customer-service`，属主为部署用户
- 已配置 `ghcr.io` 拉取权限（如私有镜像则需 `docker login ghcr.io`）

## 2. 生产 Compose 组件

| 服务 | 说明 |
|---|---|
| `app` | FastAPI 应用 |
| `migrate` | 一次性 Alembic 迁移任务 |
| `mysql` | MySQL 8.0，持久化 volume、utf8mb4、健康检查 |
| `redis` | Phase 1 预留，当前应用未消费 |
| `wechaty-bridge` | WorkPro/Wechaty Bridge（JuziBot puppet service，企业微信扫码登录） |

## 3. 首次部署

1. 复制 `.env.example` 为服务器上的 `.env`，填入真实值；
2. 至少配置：`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`DATABASE_URL`、`LLM_API_KEY`（如需要真实模型）、`LLM_AUTH_MODE`（默认 `bearer`，Azure OpenAI 用 `api-key`）、`LLM_SEND_TEMPERATURE`（默认 `true`，不接受 `temperature` 的 Azure / 推理模型改为 `false`）、`WECOM_*`；
3. 如需启动 WorkPro Bridge，再补齐：`WECHATY_PUPPET_SERVICE_TOKEN`、`WECHATY_PUPPET_SERVICE_AUTHORITY=token-service-discovery-test.juzibot.com`、`AI_BRIDGE_TOKEN`，必要时补 `WORKPRO_STAFF_USERID`；
4. 执行：

```bash
docker compose pull app migrate
docker compose --profile ops run --rm migrate
docker compose up -d app mysql redis
curl -f http://127.0.0.1:8000/health
```

启用 WorkPro Bridge：

```bash
docker compose --profile workpro up -d wechaty-bridge
docker compose --profile workpro logs -f wechaty-bridge
```

> Bridge 运行时仅支持 Node `20.x/22.x` LTS；仓库中 `bridge/Dockerfile` 固定 `node:22-bookworm-slim`，依赖必须通过 `bridge/package-lock.json` + `npm ci` 安装，避免在线解析到不兼容的 gRPC resolver 版本。

> JuziBot 试用环境建议保留 `WECHATY_PUPPET_SERVICE_AUTHORITY=token-service-discovery-test.juzibot.com`；试用 token 同时只允许登录一个企业微信账号，退出后可切换账号。默认不要关闭 TLS。收费与配额以服务商公告为准，不在应用代码中硬编码。

Azure OpenAI 示例（保持 `/openai/v1/chat/completions` 路径）：

```dotenv
LLM_BASE_URL=https://你的资源名.openai.azure.com/openai/v1/
LLM_MODEL=gpt-5.6-luna
LLM_AUTH_MODE=api-key
LLM_SEND_TEMPERATURE=false
```

> 应用不会在启动时自动建表；必须先执行 `alembic upgrade head`（通过 `migrate` 服务完成）。

## 4. GitHub Actions 配置

### 4.1 必要 Secrets

| 名称 | 用途 |
|---|---|
| `SERVER_HOST` | 部署服务器地址 |
| `SERVER_USER` | SSH 用户，例如 `TonyAdmin` |
| `SERVER_PASSWORD` | SSH 登录密码，CD 通过 `sshpass -e` 使用 |
| `DEPLOY_PATH` | 服务器部署目录，统一为 `/opt/wecom-ai-customer-service` |
| `LLM_API_KEY` | 真实模型密钥（可留空则使用 Fake） |
| `EMBEDDING_API_KEY` | 真实 embedding 密钥（可留空） |
| `WECOM_CORP_ID` / `WECOM_SECRET` / `WECOM_TOKEN` / `WECOM_AES_KEY` | 企业微信占位凭证 |

> 生产 MySQL 凭证改由服务器 `$DEPLOY_PATH/.env` 管理。GitHub Actions CD **不会**再覆盖 `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_DATABASE`、`MYSQL_USER` 或整份 `.env`。

### 4.2 临时关闭 host key 校验（安全降级说明）

当前阶段 CD 工作流临时关闭了 SSH host key 校验（`StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null`），**不需要**配置 `SERVER_KNOWN_HOSTS` 或 `SERVER_SSH_KEY`。

> 安全提示：关闭 host key 校验意味着无法确认对端服务器身份，存在中间人攻击风险。这是为完成首次部署而采用的临时方案。部署稳定后应尽快：
>
> 1. 恢复 `StrictHostKeyChecking=yes`；
> 2. 通过可信网络执行 `ssh-keyscan` 或直接读取服务器 `/etc/ssh/ssh_host_*key.pub` 获取 host key，并核对指纹；
> 3. 将 host key 重新配置为 Secret（或迁移到 known_hosts 文件管理），恢复严格校验；
> 4. 评估迁移到 SSH key 登录，替代密码登录。
>
> 密码登录弱于密钥登录，密码可能被暴力破解且无法细粒度回收。当前按需求使用密码模式。切勿把服务器密码写入仓库、文档或工作流日志。

### 4.3 推荐 Variables

`SERVER_SSH_PORT`（默认 `22`）。

应用配置（如 `APP_PORT`、`LOG_LEVEL`、`TZ`、`MYSQL_DATABASE`、`MYSQL_USER`、`LLM_*`、`EMBEDDING_*`、`DEFAULT_TENANT_*`）请直接维护在服务器 `.env`。

## 5. 更新发布

CD 工作流执行顺序：

1. 构建镜像并推送 GHCR；
2. 安装 `sshpass`，使用 `SSHPASS` 环境变量以密码方式连到服务器（当前阶段临时关闭 host key 校验，见 4.2）；
3. 上传最新 `docker-compose.yml`；
4. 在服务器检查 `$DEPLOY_PATH/.env` 已存在，且至少包含 `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`DATABASE_URL`；
5. 仅更新 `.env` 中的 `APP_IMAGE` 为本次构建镜像（若不存在则追加该项），不改写其他配置；
6. `docker compose pull app migrate`；
7. `docker compose --profile ops run --rm migrate`；
8. `docker compose up -d app mysql redis`；
8. 如需 Bridge：`docker compose --profile workpro up -d wechaty-bridge`；
9. `curl /health` 校验。

若迁移失败，发布应停止，不应继续重启应用容器。

若本次发布包含 `bridge/` 变更，服务器需先同步最新 `main` 的 `bridge/` 目录，然后执行：

```bash
cd /opt/wecom-ai-customer-service
docker compose --profile workpro stop wechaty-bridge || true
docker compose --profile workpro rm -f wechaty-bridge || true
docker compose --profile workpro build --no-cache --pull wechaty-bridge
docker compose --profile workpro up wechaty-bridge
```

预期 Bridge 不再出现 `ERR_INVALID_ARG_TYPE` resolver callback 异常，并继续进入扫码/二维码登录流程。

## 6. 日志与健康检查

```bash
docker compose logs -f app
docker compose logs -f mysql
curl -f http://127.0.0.1:8000/health
```

## 7. 备份与恢复

### 7.1 备份
```bash
docker compose exec mysql sh -c 'mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' > backup.sql
```

### 7.2 恢复
```bash
cat backup.sql | docker compose exec -T mysql sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

## 8. 手动回滚

CD 会在部署目录保存上一镜像标识（如 `.previous_app_image`）。手动回滚步骤：

```bash
export APP_IMAGE=$(cat .previous_app_image)
docker compose pull app
docker compose up -d app
curl -f http://127.0.0.1:8000/health
```

> 若迁移已前滚且不可逆，需先评估数据兼容性；本阶段仅提供回滚说明，不自动执行 schema downgrade。

## 9. TODO(confirm-with-wecom-docs)

- 企业微信真实消息发送、AES 解密、会话窗口与主动回访限制仍需官方文档/测试企业确认。
