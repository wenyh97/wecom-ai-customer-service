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
3. CD 会自动维护 `APP_IMAGE` / `BRIDGE_IMAGE`；建议在服务器 `.env` 预留空值或不写这两个字段，后续由 main 分支 CD 原子更新为对应 `sha-<commit>` GHCR 镜像；
4. 默认 `DEPLOY_WORKPRO=false`。如需让 CD 自动部署 WorkPro Bridge，请显式设为 `DEPLOY_WORKPRO=true`，并补齐：`WECHATY_PUPPET_SERVICE_TOKEN`、`WECHATY_PUPPET_SERVICE_AUTHORITY=token-service-discovery-test.juzibot.com`、`WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_CLIENT=true`、`AI_BRIDGE_TOKEN`、`BRIDGE_WEB_TOKEN`，必要时补 `WORKPRO_STAFF_USERID`；
5. 推荐同时确认 `BRIDGE_WEB_PORT`（默认 `18080`）、`BRIDGE_WEB_BIND_HOST=127.0.0.1`；Docker Compose 默认仅把控制台发布到服务器本机回环地址，供 SSH 隧道或服务器本地浏览器访问；
6. 执行：

```bash
docker compose pull app migrate
docker compose pull mysql redis
docker compose --profile ops run --rm migrate
docker compose up -d --no-build app mysql redis
curl -f http://127.0.0.1:8000/health
```

如需手动首次启用 WorkPro Bridge（通常仅首装/排障需要）：

```bash
docker compose --profile workpro pull wechaty-bridge
docker compose --profile workpro up -d --no-build --force-recreate --no-deps wechaty-bridge
docker compose --profile workpro logs -f wechaty-bridge
```

如从本地电脑访问，先建立 SSH 隧道，再打开浏览器：

```bash
ssh -L 18080:127.0.0.1:18080 TonyAdmin@服务器
```

随后访问：

```text
http://127.0.0.1:18080/
```

> Bridge 运行时仅支持 Node `20.x/22.x` LTS；仓库中 `bridge/Dockerfile` 固定 `node:22-bookworm-slim`，依赖必须通过 `bridge/package-lock.json` + `npm ci` 安装。当前审计策略为固定 `@grpc/grpc-js@1.13.5`，并在仓库内用 `bridge/src/grpc-resolver-compat.ts` 把 `wechaty-token@1.1.2` 的旧 `{host, port}` resolver 结果包装成 endpoint-list 形状。

> JuziBot 试用环境建议保留 `WECHATY_PUPPET_SERVICE_AUTHORITY=token-service-discovery-test.juzibot.com`；当前生产现网 discovery 返回 `101.126.67.87:4001` 明文 gRPC 端口，因此运行 Bridge 时需要 `WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_CLIENT=true`。本任务不会在代码里偷偷改写该行为。试用 token 同时只允许登录一个企业微信账号，退出后可切换账号。收费与配额以服务商公告为准，不在应用代码中硬编码。

> 首次启动或镜像升级后，Bridge 可能需要重新扫码或输入验证码。首次登录仍建议保持前台观察日志，不要立即后台化隐藏诊断输出；登录操作已转移到浏览器控制台完成：通过页面查看二维码，扫码后若手机端提示验证码，则在页面输入提交；不要再通过 SSH 终端输入验证码。

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

> 生产 MySQL 凭证改由服务器 `$DEPLOY_PATH/.env` 管理。GitHub Actions CD **不会**再覆盖 `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_DATABASE`、`MYSQL_USER`、`WECHATY_PUPPET_SERVICE_TOKEN`、`BRIDGE_WEB_TOKEN`、`AI_BRIDGE_TOKEN` 或整份 `.env`；它只会原子更新 `APP_IMAGE` / `BRIDGE_IMAGE`。

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

1. 分别构建并推送 app 与 `wechaty-bridge` 两个 GHCR 镜像，同时生成 immutable `sha-<commit>` tag 与 `latest` tag；
2. 安装 `sshpass`，使用 `SSHPASS` 环境变量以密码方式连到服务器（当前阶段临时关闭 host key 校验，见 4.2）；
3. 上传最新 `docker-compose.yml`；
4. 在服务器检查 `$DEPLOY_PATH/.env` 已存在，且至少包含 `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`DATABASE_URL`；
5. 原子更新 `.env` 中的 `APP_IMAGE` / `BRIDGE_IMAGE` 为本次 immutable SHA 镜像（若不存在则追加），不改写其他配置；
6. 若 `DEPLOY_WORKPRO=true`，先校验 `WECHATY_PUPPET_SERVICE_TOKEN`、`AI_BRIDGE_TOKEN`、`BRIDGE_WEB_TOKEN` 已在服务器 `.env` 配置，再执行 `docker compose --profile workpro pull app migrate wechaty-bridge`；否则记录 `WorkPro disabled` 并只执行 `docker compose pull app migrate`；
7. 执行 `docker compose pull mysql redis`，确保 fresh server 或清理缓存后的宿主机仍可配合 `--no-build` 拉起基础服务；
8. `docker compose --profile ops run --rm migrate`；
9. `docker compose up -d --no-build app mysql redis`，随后执行 app `/health` 校验并输出 `docker compose ps`；
10. 若 `DEPLOY_WORKPRO=true`，执行 `docker compose --profile workpro up -d --no-build --force-recreate --no-deps wechaty-bridge`，等待容器健康检查通过，再校验 `http://127.0.0.1:${BRIDGE_WEB_PORT:-18080}/health` 并输出 `docker compose --profile workpro ps`；
11. 任一步失败均返回非零，CD 标红。

若迁移失败，发布应停止，不应继续重启应用容器。

从现在开始，**main 分支 CD 不再要求手动同步 `bridge/` 目录，也不再要求服务器执行 `docker compose build wechaty-bridge`**。刷新浏览器即可看到随 Bridge 镜像一起发布的最新 Web 控制台和前端 Demo。

二阶段 resolver 问题的实际根因：`wechaty-token@1.1.2` 仍按旧 listener 约定把 `TcpSubchannelAddress[]` 直接传给 `onSuccessfulResolution(...)`，而 `grpc-js@1.13.5` 的 load balancer 已按 endpoint-list 读取，最终会在 `'port' in undefined` 处崩溃。仅验证 callback 存在不足以验收，必须做无缓存重建并检查镜像内状态：

```bash
docker compose --profile workpro run --rm --entrypoint sh wechaty-bridge -lc \
  'node -v && npm ls @grpc/grpc-js wechaty-token --depth=0 && test -f dist/src/grpc-resolver-compat.js'
```

发布验收标准：

- 镜像内 Node 为 `22.x`
- 镜像内 `@grpc/grpc-js` 为 `1.13.5`
- 镜像内 `wechaty-token` 为 `1.1.2`
- 镜像内存在编译后的 `dist/src/grpc-resolver-compat.js`
- 服务器 `.env` 中的 `APP_IMAGE` / `BRIDGE_IMAGE` 已更新到本次 `sha-<commit>` 镜像
- Bridge 日志不再出现 `ERR_INVALID_ARG_TYPE`
- Bridge 日志不再出现 `Cannot use 'in' operator to search for 'port' in undefined`
- 本地浏览器通过 SSH 隧道访问 `http://127.0.0.1:18080/` 后可以看到二维码
- 扫码后如页面提示验证码，可直接在页面提交；提交后日志继续出现 `login` / `ready`
- Bridge 成功进入 scan/二维码流程；这比“进程启动数秒未退出”更重要

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

CD 会在部署目录保存上一镜像标识（如 `.previous_app_image`、`.previous_bridge_image`）。手动回滚步骤：

```bash
export APP_IMAGE=$(cat .previous_app_image)
docker compose pull app
docker compose up -d --no-build app
curl -f http://127.0.0.1:8000/health
```

若本次同时回滚 Bridge：

```bash
export BRIDGE_IMAGE=$(cat .previous_bridge_image)
docker compose --profile workpro pull wechaty-bridge
docker compose --profile workpro up -d --no-build --force-recreate --no-deps wechaty-bridge
curl -f http://127.0.0.1:18080/health
```

> 若迁移已前滚且不可逆，需先评估数据兼容性；本阶段仅提供回滚说明，不自动执行 schema downgrade。

## 9. TODO(confirm-with-wecom-docs)

- 企业微信真实消息发送、AES 解密、会话窗口与主动回访限制仍需官方文档/测试企业确认。
