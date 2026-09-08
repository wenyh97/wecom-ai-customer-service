> **说明**：本文档为仓库历史遗留内容（Hermes Agent 远程部署指南），与当前“企业微信客户 AI 客服与回访助手”项目无直接关系，保留于此仅供参考，不再维护。当前项目请从根目录 [README.md](../../README.md) 开始阅读。

# TonyNote（历史文档）

Hermes Agent 远程 Linux 后端、Caddy HTTPS 反向代理与 Windows Desktop 客户端部署指南。

> 推荐架构：Windows 只运行 Hermes Desktop；Linux 运行 Hermes Agent、模型配置、Skills、MCP、浏览器自动化和消息 Gateway。

```text
Windows Hermes Desktop
        │ HTTPS + WebSocket
        ▼
https://hermes.example.com
        │
        ▼
Caddy :443 ───────► Hermes serve 127.0.0.1:9119
```

## 1. Linux 安装 Hermes

SSH 登录服务器：

```bash
ssh <user>@<server>
```

安装并检查：

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/install-hermes.sh
less /tmp/install-hermes.sh
bash /tmp/install-hermes.sh

hermes --version
hermes doctor
```

如果需要配置模型或账号，之后再执行：

```bash
hermes setup --portal
# 或：hermes setup
```

## 2. 配置 Hermes 认证

创建环境文件：

```bash
mkdir -p ~/.hermes
nano ~/.hermes/.env
```

加入强密码和稳定的 Session Secret：

```dotenv
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<strong-password>
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<random-secret>
HERMES_DASHBOARD_PUBLIC_URL=https://hermes.example.com
```

生成随机 Secret：

```bash
openssl rand -base64 32
```

保护文件：

```bash
chmod 700 ~/.hermes
chmod 600 ~/.hermes/.env
```

## 3. 先测试 Hermes 后端

临时启动：

```bash
hermes serve --host 127.0.0.1 --port 9119
```

另开一个 SSH 窗口验证：

```bash
curl -i http://127.0.0.1:9119/api/status
```

确认监听地址：

```bash
ss -lntp | grep -E ':9119'
```

应为 `127.0.0.1:9119`。不要直接把 9119 暴露到公网。

## 4. 配置 Caddy HTTPS 反向代理

将域名 DNS 的 A 记录指向服务器公网 IP，例如：

```text
hermes.example.com  A  <server-public-ip>
```

开放云平台安全组和 Linux 防火墙的 80、443 端口：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw delete allow 9119/tcp 2>/dev/null || true
sudo ufw reload
```

安装 Caddy（Ubuntu/Debian）：

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

编辑 `/etc/caddy/Caddyfile`：

```caddyfile
hermes.example.com {
    reverse_proxy 127.0.0.1:9119
}
```

域名与 `{` 之间必须有空格。检查并启动：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl status caddy
```

Caddy 会自动申请和续期 HTTPS 证书，并支持 WebSocket 转发。

## 5. 验证公网访问

Windows PowerShell：

```powershell
nslookup hermes.example.com
curl.exe -i https://hermes.example.com/api/status
curl.exe -i https://hermes.example.com/api/config
curl.exe -i https://hermes.example.com/api/env
```

预期：

- `/api/status` 返回 200 是正常的健康检查行为；
- `/api/config` 和 `/api/env` 未登录时应返回 401；
- 通过 `https://` 访问，不要使用 `:9119` 公网地址。

服务器监听应类似：

```text
127.0.0.1:9119  hermes
*:80             caddy
*:443            caddy
```

## 6. 配置 Hermes systemd 服务

停止临时前台进程（`Ctrl+C`），确认 Hermes 路径：

```bash
command -v hermes
```

创建用户服务：

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/hermes-serve.service
```

内容如下，将路径替换为 `command -v hermes` 的实际结果：

```ini
[Unit]
Description=Hermes Agent Remote Backend
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.local/bin/hermes serve --host 127.0.0.1 --port 9119
WorkingDirectory=%h
EnvironmentFile=%h/.hermes/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

启用并查看日志：

```bash
systemctl --user daemon-reload
systemctl --user enable --now hermes-serve
systemctl --user status hermes-serve
journalctl --user -u hermes-serve -f
```

让服务在 SSH 退出后继续运行：

```bash
sudo loginctl enable-linger "$USER"
```

## 7. 安装 Windows Desktop

从官方页面下载**预编译** Windows Desktop：

<https://hermes-agent.nousresearch.com/desktop>

不要用以下命令现场构建：

```bat
hermes desktop
```

首次启动：

1. 让安装器完成必要的 Desktop 引导安装；
2. 进入 Hermes Desktop 后选择 **Connect to existing Hermes**；
3. 不选择 **Install Hermes locally**；
4. 进入 **Settings → Gateways → Remote gateway**；
5. 填写：

```text
https://hermes.example.com
```

6. 使用 Linux `.env` 中的用户名和密码登录；
7. 保存并测试聊天连接。

某些 Windows 安装包会先执行一次本地 Desktop 引导安装，这是安装客户端运行环境的流程；远程连接选项通常在引导完成、Desktop 主界面启动后出现。

## 8. 配置迁移（可选）

建议先确认远程连接正常，再迁移配置。优先迁移：

```text
config.yaml
.env
skills/
profiles/
plugins/
kanban.db
```

不要直接迁移：

```text
venv/
node_modules/
apps/desktop/
Windows 缓存
```

Windows 路径（例如 `C:\Users\...`）不能原样用于 Linux。`.env` 含有密钥，不要提交 Git 或公开分享。

示例：

```powershell
scp "$env:USERPROFILE\Desktop\hermes-backup\config.yaml" `
  <user>@<server>:~/.hermes/config.yaml
scp "$env:USERPROFILE\Desktop\hermes-backup\.env" `
  <user>@<server>:~/.hermes/.env
```

Linux 上修正权限：

```bash
chmod 600 ~/.hermes/config.yaml ~/.hermes/.env
```

## 9. 安全检查清单

- 公网只开放 80/443；不要开放 9119。
- Hermes 只监听 `127.0.0.1:9119`，由 Caddy 代理。
- 使用 HTTPS 和强 Basic Auth 密码；公网长期部署更推荐 OAuth。
- Azure NSG 和 Linux 防火墙都检查一遍。
- SSH 22 端口尽量限制为固定管理 IP，或通过 Tailscale 访问。
- Caddy 配置变更后运行：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

- 服务异常时查看：

```bash
sudo journalctl -u caddy -n 100 --no-pager
journalctl --user -u hermes-serve -n 100 --no-pager
```

## 10. 更新方式

Linux 后端：

```bash
hermes update
systemctl --user restart hermes-serve
```

Windows Desktop：使用 Desktop 内置的 **Update desktop app**，或从官方页面下载最新版预编译安装器覆盖安装。不要在 Windows 运行 `hermes update` 来维护远程 Linux 后端。

## 参考

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Hermes Desktop 远程后端文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md)
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
