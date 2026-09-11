import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

import QRCode from 'qrcode'
import { ScanStatus, type Wechaty } from '@juzi/wechaty'

import type { VerifyCodeSubmitter } from './verify-code'

export interface BridgeWebConfig {
  webHost: string
  webPort: number
  webToken: string
  webSessionTtlMs: number
  webVerifyTimeoutMs: number
}

export interface BridgeLoggerLike {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  error: (message: string, fields?: Record<string, unknown>) => void
}

type BridgePhase =
  | 'starting'
  | 'waiting-scan'
  | 'waiting-verify-code'
  | 'verify-code-submitted'
  | 'logged-in'
  | 'ready'
  | 'logged-out'
  | 'verify-code-expired'
  | 'error'

interface AuthSession {
  csrfToken: string
  expiresAt: number
}

interface VerifyCodeChallenge {
  eventId: string
  requestId: string
  prompt: string
  scene: number
  status: number
  expiresAt: number
  timer: NodeJS.Timeout
  submitting: boolean
  submittedAt?: string
  lastError?: string
}

interface ControlState {
  phase: BridgePhase
  message: string
  lastUpdatedAt: string
  qrCodeSvg: string | null
  qrCodeStatus: string | number | null
  qrCodeUpdatedAt: string | null
  loginUser: { id: string | null, name: string | null } | null
  verifyCode: VerifyCodeChallenge | null
}

interface StatusResponse {
  phase: BridgePhase
  message: string
  lastUpdatedAt: string
  qrCodeSvg: string | null
  qrCodeStatus: string | number | null
  qrCodeUpdatedAt: string | null
  loginUser: { id: string | null, name: string | null } | null
  verifyCode: null | {
    required: boolean
    requestId: string
    prompt: string
    scene: number
    status: number
    expiresAt: string
    submitting: boolean
    submittedAt: string | null
    lastError: string | null
  }
}

function nowIso (now: () => number): string {
  return new Date(now()).toISOString()
}

function createToken (): string {
  return randomBytes(24).toString('hex')
}

function maskIdentifier (value: string | undefined): string | null {
  if (!value) {
    return null
  }
  return value.length <= 6 ? '***' : `${value.slice(0, 2)}***${value.slice(-2)}`
}

function sanitizePrompt (message: string): string {
  const trimmed = message.trim()
  return trimmed === '' ? '请查看企业微信手机端并输入验证码。' : trimmed
}

function safeCompare (left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function parseCookies (cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {}
  }
  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, pair) => {
      const separatorIndex = pair.indexOf('=')
      if (separatorIndex <= 0) {
        return cookies
      }
      const name = pair.slice(0, separatorIndex).trim()
      const value = pair.slice(separatorIndex + 1).trim()
      cookies[name] = decodeURIComponent(value)
      return cookies
    }, {})
}

function isJsonRequest (request: http.IncomingMessage): boolean {
  return request.headers['content-type']?.includes('application/json') ?? false
}

async function readJsonBody<T> (request: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) {
    return null
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function setNoStoreHeaders (response: http.ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'same-origin')
}

function writeJson (response: http.ServerResponse, statusCode: number, payload: unknown): void {
  setNoStoreHeaders(response)
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function escapeHtml (value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function isSameOrigin (request: http.IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (!origin || !host) {
    return false
  }
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function readSingleHeader (value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function renderPage (tokenRequired: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>麻花 AI 营销工作台（Demo）</title>
  <style>
    :root {
      --bg: #f4eee5;
      --panel: #fbf7f1;
      --card: #fffdf9;
      --text: #1e1b18;
      --muted: #6d6257;
      --line: #e0d7cc;
      --accent: #9c4c39;
      --accent-soft: #eed8d1;
      --success: #266c52;
      --danger: #9f2a2a;
      --radius-lg: 18px;
      --radius-md: 12px;
      --radius-sm: 10px;
      --shadow: 0 8px 24px rgba(46, 35, 27, 0.08);
      --space-1: 8px;
      --space-2: 12px;
      --space-3: 16px;
      --space-4: 20px;
      --space-5: 24px;
      --space-6: 32px;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); }
    button, input { font: inherit; }
    button, input, [role="button"] { outline: none; }
    button:focus-visible, input:focus-visible, .nav-btn:focus-visible, .tab-btn:focus-visible {
      box-shadow: 0 0 0 3px rgba(156, 76, 57, 0.25);
    }
    .hidden { display: none !important; }
    .demo-tag { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; font-size: 12px; color: var(--muted); background: #fff; }
    .page-shell { min-height: 100vh; padding: var(--space-4); }

    .login-wrap { max-width: 480px; margin: 48px auto; }
    .login-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: var(--space-6);
    }
    .login-title { margin: 0 0 var(--space-2); font-size: 34px; letter-spacing: 0.5px; }
    .muted { color: var(--muted); }
    .login-form { display: grid; gap: var(--space-3); margin-top: var(--space-5); }
    .field { display: grid; gap: 8px; }
    .field label { font-size: 14px; color: var(--muted); }
    .input {
      width: 100%; border: 1px solid var(--line); border-radius: var(--radius-sm);
      padding: 11px 12px; background: #fff;
    }
    .btn {
      border: 1px solid transparent; border-radius: var(--radius-sm); padding: 10px 14px;
      background: var(--accent); color: #fff; cursor: pointer;
    }
    .btn[disabled] { opacity: 0.6; cursor: not-allowed; }
    .btn-secondary { background: #fff; color: var(--text); border-color: var(--line); }
    .error { color: var(--danger); margin: 0; }
    .success { color: var(--success); margin: 0; }

    .app {
      display: grid;
      grid-template-columns: 244px minmax(0, 1fr);
      gap: var(--space-4);
      min-height: calc(100vh - var(--space-4) * 2);
    }
    .sidebar {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: var(--space-4);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .brand h1 { margin: 0; font-size: 22px; }
    .brand p { margin: 6px 0 0; color: var(--muted); }
    .nav { display: grid; gap: 8px; }
    .nav-btn {
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-btn.active { background: #fff; border-color: var(--line); color: var(--accent); font-weight: 600; }
    .sidebar-foot { margin-top: auto; border-top: 1px solid var(--line); padding-top: var(--space-3); font-size: 12px; color: var(--muted); }

    .content {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: var(--space-4);
      display: grid;
      grid-template-rows: auto 1fr;
      gap: var(--space-4);
    }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); border-bottom: 1px solid var(--line); padding-bottom: var(--space-3); }
    .topbar h2 { margin: 0; font-size: 28px; }
    .top-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .status-pill { border-radius: 999px; background: #fff; border: 1px solid var(--line); padding: 6px 10px; font-size: 12px; }

    .page { display: none; }
    .page.active { display: block; }
    .grid { display: grid; gap: var(--space-3); }
    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      padding: var(--space-4);
    }
    .card h3 { margin: 0 0 8px; }
    .card p { margin: 0; color: var(--muted); }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
    .section-head h3 { margin: 0; }

    .chat-box { min-height: 220px; max-height: 320px; overflow: auto; display: grid; gap: 8px; padding: var(--space-2); border: 1px solid var(--line); border-radius: var(--radius-sm); background: #fff; }
    .chat-msg { padding: 8px 10px; border-radius: 10px; max-width: 88%; line-height: 1.5; }
    .chat-msg.user { margin-left: auto; background: var(--accent-soft); }
    .chat-msg.ai { background: #f4f0e8; }
    .chat-compose { display: grid; grid-template-columns: 1fr auto; gap: var(--space-2); margin-top: var(--space-2); }
    .quick-links { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
    .quick-btn { width: 100%; text-align: left; border: 1px solid var(--line); border-radius: var(--radius-sm); background: #fff; padding: 10px; cursor: pointer; }

    .bridge-qr { min-height: 220px; display: flex; align-items: center; justify-content: center; background: #fff; border: 1px dashed var(--line); border-radius: var(--radius-sm); margin-top: var(--space-2); }
    .bridge-qr svg { width: min(100%, 280px); height: auto; }

    .tool-btn { width: 100%; margin-top: var(--space-3); }

    .modal-mask {
      position: fixed;
      inset: 0;
      background: rgba(30, 27, 24, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-4);
      z-index: 100;
    }
    .modal {
      width: min(560px, 100%);
      background: var(--card);
      border-radius: var(--radius-lg);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      padding: var(--space-5);
    }
    .modal h3 { margin-top: 0; }

    .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .tag { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; font-size: 12px; color: var(--muted); background: #fff; }

    .tabs { display: flex; gap: 8px; }
    .tab-btn { border: 1px solid var(--line); background: #fff; color: var(--text); border-radius: 999px; padding: 6px 10px; cursor: pointer; }
    .tab-btn.active { border-color: var(--accent); color: var(--accent); }

    .chart { height: 120px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: linear-gradient(to top, #f4ece3 0%, #f4ece3 22%, transparent 22%), #fff; position: relative; overflow: hidden; }
    .chart svg { width: 100%; height: 100%; display: block; }

    @media (max-width: 1024px) {
      .grid.three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .quick-links { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 860px) {
      .page-shell { padding: var(--space-2); }
      .app { grid-template-columns: 1fr; }
      .sidebar { gap: var(--space-3); }
      .nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .nav-btn { font-size: 13px; padding: 8px; justify-content: center; text-align: center; }
      .grid.two, .grid.three { grid-template-columns: 1fr; }
      .quick-links { grid-template-columns: 1fr; }
      .topbar { flex-direction: column; align-items: flex-start; }
      .chat-compose { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="page-shell">
    <section id="login-screen" class="login-wrap">
      <article class="login-card">
        <span class="demo-tag">Demo 登录</span>
        <h1 class="login-title">麻花 AI 营销工作台</h1>
        <p class="muted">这是前端 Demo 登录页面，不代表真实多用户权限系统。用户名固定为 <strong>admin</strong>，密码校验沿用后端会话认证流程（BRIDGE_WEB_TOKEN）。</p>
        <form id="login-form" class="login-form">
          <div class="field">
            <label for="login-username">用户名</label>
            <input id="login-username" class="input" type="text" value="admin" required>
          </div>
          <div class="field">
            <label for="login-password">密码</label>
            <input id="login-password" class="input" type="password" autocomplete="current-password" required>
          </div>
          <button id="login-submit" class="btn" type="submit">登录工作台</button>
        </form>
        <p id="login-error" class="error hidden"></p>
      </article>
    </section>

    <section id="app-screen" class="app hidden" aria-live="polite">
      <aside class="sidebar">
        <header class="brand">
          <h1>麻花 AI</h1>
          <p>营销工作台</p>
        </header>
        <nav class="nav" aria-label="工作台导航">
          <button class="nav-btn active" data-nav="chat" type="button">💬 对话创作</button>
          <button class="nav-btn" data-nav="assets" type="button">🗂️ 内容资产</button>
          <button class="nav-btn" data-nav="tools" type="button">🧰 工具</button>
          <button class="nav-btn" data-nav="rag" type="button">📚 AI 知识库（RAG）</button>
          <button class="nav-btn" data-nav="stats" type="button">📊 数据统计</button>
          <button class="nav-btn" data-nav="admin" type="button">⚙️ 管理</button>
        </nav>
        <footer class="sidebar-foot">
          Demo 环境 / 本地工作空间
        </footer>
      </aside>

      <section class="content">
        <header class="topbar">
          <div>
            <h2 id="page-title">对话创作</h2>
            <p class="muted" id="page-subtitle">静态 Demo 预览，后端能力逐步接入。</p>
          </div>
          <div class="top-meta">
            <span id="service-status" class="status-pill">服务状态：连接中</span>
            <span class="status-pill">当前用户：admin</span>
            <button id="logout-btn" type="button" class="btn btn-secondary">退出登录</button>
          </div>
        </header>

        <div>
          <section id="page-chat" class="page active">
            <div class="grid two">
              <article class="card">
                <div class="section-head">
                  <h3>AI 对话创作（Demo）</h3>
                  <span class="demo-tag">静态预览</span>
                </div>
                <p class="muted">欢迎回来，admin。你可以在这里预览营销话术创作流。</p>
                <div id="chat-box" class="chat-box" aria-label="对话记录">
                  <div class="chat-msg ai">你好，我是营销助手 Demo。可以先试试“秋季促销开场白”。</div>
                </div>
                <form id="chat-form" class="chat-compose">
                  <input id="chat-input" class="input" type="text" placeholder="输入你的营销创作需求（仅本地 Demo 回复）" required>
                  <button id="chat-send" class="btn" type="submit">发送</button>
                </form>
                <div class="quick-links" style="margin-top: 12px;">
                  <button class="quick-btn" type="button" data-quick="写一条周末会员关怀文案">周末关怀</button>
                  <button class="quick-btn" type="button" data-quick="生成新品发布朋友圈文案">新品发布</button>
                  <button class="quick-btn" type="button" data-quick="客户沉默七天后如何唤醒">客户唤醒</button>
                </div>
              </article>

              <article class="card">
                <div class="section-head">
                  <h3>连接状态（保留真实 Bridge 能力）</h3>
                  <span class="status-pill" id="bridge-phase">starting</span>
                </div>
                <p id="bridge-message" class="muted">Bridge 正在启动，请稍候。</p>
                <p class="muted">最近更新：<span id="bridge-updated-at">-</span></p>
                <p class="muted">二维码状态：<span id="bridge-qr-status">-</span></p>
                <p class="muted">当前登录：<span id="bridge-login-user">-</span></p>
                <div id="bridge-qr" class="bridge-qr"><span class="muted">等待二维码...</span></div>
                <div id="verify-wrap" class="hidden" style="margin-top: 12px;">
                  <p id="verify-prompt" class="muted"></p>
                  <form id="verify-form" class="chat-compose">
                    <input id="verify-code" class="input" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="输入验证码" required>
                    <button id="verify-submit" class="btn" type="submit">提交验证码</button>
                  </form>
                  <p id="verify-feedback" class="hidden"></p>
                </div>
              </article>
            </div>
          </section>

          <section id="page-assets" class="page">
            <article class="card">
              <div class="section-head">
                <h3>内容资产库（Demo）</h3>
                <span class="demo-tag">仅前端筛选</span>
              </div>
              <input id="asset-search" class="input" type="search" placeholder="搜索模板或标签，如：节日 / FAQ">
              <div id="asset-list" class="grid two" style="margin-top: 12px;">
                <article class="card asset-item" data-title="欢迎语模板" data-tags="欢迎 新客 开场">
                  <h3>欢迎语模板</h3>
                  <p>用于首次触达新客户的标准开场。</p>
                  <div class="tags"><span class="tag">欢迎</span><span class="tag">新客</span></div>
                </article>
                <article class="card asset-item" data-title="节日问候" data-tags="节日 关怀 活动">
                  <h3>节日问候</h3>
                  <p>中秋、国庆等节日场景模板集合。</p>
                  <div class="tags"><span class="tag">节日</span><span class="tag">关怀</span></div>
                </article>
                <article class="card asset-item" data-title="产品介绍" data-tags="产品 卖点 话术">
                  <h3>产品介绍</h3>
                  <p>核心产品卖点与常见提问答复。</p>
                  <div class="tags"><span class="tag">产品</span><span class="tag">卖点</span></div>
                </article>
                <article class="card asset-item" data-title="FAQ" data-tags="FAQ 问答 客服">
                  <h3>FAQ</h3>
                  <p>高频问题的统一回答示例。</p>
                  <div class="tags"><span class="tag">FAQ</span><span class="tag">客服</span></div>
                </article>
              </div>
            </article>
          </section>

          <section id="page-tools" class="page">
            <article class="card">
              <div class="section-head">
                <h3>工具（Demo）</h3>
                <span class="demo-tag">后端能力即将接入</span>
              </div>
              <div class="grid three">
                <article class="card"><h3>👋 欢迎语</h3><p>根据客户标签生成开场语。</p><button class="btn btn-secondary tool-btn" data-tool="欢迎语" type="button">立即体验</button></article>
                <article class="card"><h3>⏰ 定时推送</h3><p>设置节奏化客户触达任务。</p><button class="btn btn-secondary tool-btn" data-tool="定时推送" type="button">立即体验</button></article>
                <article class="card"><h3>⚡ 快捷回复</h3><p>常见场景一键引用回复。</p><button class="btn btn-secondary tool-btn" data-tool="快捷回复" type="button">立即体验</button></article>
                <article class="card"><h3>🧾 会话记录</h3><p>按客户查看沟通摘要 Demo。</p><button class="btn btn-secondary tool-btn" data-tool="会话记录" type="button">立即体验</button></article>
                <article class="card"><h3>🧠 AI 客户画像分析</h3><p>聚类识别客户意向与偏好。</p><button class="btn btn-secondary tool-btn" data-tool="AI 客户画像分析" type="button">立即体验</button></article>
                <article class="card"><h3>📈 AI 老客维护策略推荐</h3><p>提供复购与沉睡唤醒建议。</p><button class="btn btn-secondary tool-btn" data-tool="AI 老客维护策略推荐" type="button">立即体验</button></article>
              </div>
            </article>
          </section>

          <section id="page-rag" class="page">
            <article class="card">
              <div class="section-head">
                <h3>AI 知识库（RAG）</h3>
                <span class="demo-tag">静态指标 Demo</span>
              </div>
              <div class="chat-compose" style="margin: 0 0 12px;">
                <input id="rag-query" class="input" type="text" placeholder="输入检索关键词，例如：退换货政策">
                <button id="rag-search" class="btn" type="button">检索</button>
              </div>
              <div class="tabs" style="margin-bottom: 10px;">
                <span class="status-pill">命中率：82%</span>
                <span class="status-pill">覆盖率：74%</span>
                <button id="rag-add" class="btn btn-secondary" type="button">添加文档</button>
              </div>
              <div class="grid two">
                <article class="card"><h3>售后服务手册 v2</h3><p>标签：售后 / 退款 / 物流</p></article>
                <article class="card"><h3>新品发布培训稿</h3><p>标签：产品 / 卖点 / 异议处理</p></article>
                <article class="card"><h3>会员运营 SOP</h3><p>标签：老客 / 复购 / 关怀</p></article>
                <article class="card"><h3>品牌语调规范</h3><p>标签：品牌 / 文案 / 口吻</p></article>
              </div>
              <p id="rag-feedback" class="muted" style="margin-top: 12px;">Demo 数据仅用于前端展示。</p>
            </article>
          </section>

          <section id="page-stats" class="page">
            <article class="card">
              <div class="section-head">
                <h3>数据统计（Demo）</h3>
                <div class="tabs" role="tablist" aria-label="时间范围">
                  <button class="tab-btn active" data-range="today" type="button">今日</button>
                  <button class="tab-btn" data-range="7d" type="button">7天</button>
                  <button class="tab-btn" data-range="30d" type="button">30天</button>
                </div>
              </div>
              <div class="grid two">
                <article class="card"><h3>会话数</h3><p id="metric-chat">1,280</p></article>
                <article class="card"><h3>触达客户</h3><p id="metric-customers">436</p></article>
                <article class="card"><h3>AI 回复率</h3><p id="metric-ai-rate">78%</p></article>
                <article class="card"><h3>转人工率</h3><p id="metric-human-rate">12%</p></article>
              </div>
              <div class="chart" style="margin-top: 12px;">
                <svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-label="趋势图">
                  <polyline fill="none" stroke="#9c4c39" stroke-width="3" points="0,92 80,75 160,70 240,58 320,62 400,46 480,40 560,28 600,33"></polyline>
                </svg>
              </div>
            </article>
          </section>

          <section id="page-admin" class="page">
            <article class="card">
              <div class="section-head">
                <h3>管理（Demo）</h3>
                <span class="demo-tag">仅内存状态</span>
              </div>
              <div class="grid two">
                <article class="card"><h3>账号信息</h3><p>用户名：admin（Demo）</p></article>
                <article class="card"><h3>Bridge 连接状态</h3><p id="admin-bridge-phase">starting</p></article>
                <article class="card"><h3>Web 控制台状态</h3><p id="admin-web-status">运行中</p></article>
                <article class="card">
                  <h3>Demo 设置</h3>
                  <label style="display:flex;align-items:center;gap:8px;margin-top:8px;"><input id="theme-toggle" type="checkbox">暖色主题增强</label>
                  <label style="display:flex;align-items:center;gap:8px;margin-top:8px;"><input id="notify-toggle" type="checkbox" checked>接收通知提醒</label>
                </article>
              </div>
              <p id="admin-feedback" class="muted" style="margin-top: 12px;">不会展示任何 Token 或密钥。</p>
            </article>
          </section>
        </div>
      </section>
    </section>
  </main>

  <div id="tool-modal-mask" class="modal-mask hidden" role="dialog" aria-modal="true" aria-labelledby="tool-modal-title">
    <article class="modal">
      <h3 id="tool-modal-title">工具详情</h3>
      <p id="tool-modal-content" class="muted"></p>
      <p class="muted">后端能力即将接入，当前仅为静态 Demo 展示。</p>
      <button id="tool-modal-close" type="button" class="btn btn-secondary">关闭</button>
    </article>
  </div>

  <script>
    const bootstrap = { tokenRequired: ${tokenRequired ? 'true' : 'false'} }
    let csrfToken = null
    let eventSource = null
    let latestRequestId = null
    let manualLoggedOut = false
    let selectedPage = 'chat'

    const pageMeta = {
      chat: { title: '对话创作', subtitle: '静态 Demo 预览，后端能力逐步接入。' },
      assets: { title: '内容资产', subtitle: '支持本地搜索与标签筛选，不做持久化。' },
      tools: { title: '工具', subtitle: '工具详情为静态内容，后端能力即将接入。' },
      rag: { title: 'AI 知识库（RAG）', subtitle: '检索与指标均为 Demo 数据。' },
      stats: { title: '数据统计', subtitle: '图表与指标为前端静态演示数据。' },
      admin: { title: '管理', subtitle: '仅用于 Demo 设置展示，不存储到后端。' },
    }

    const toolDescriptions = {
      '欢迎语': '根据客户来源与标签生成暖场欢迎语模板。',
      '定时推送': '配置触达节奏、发送时段与内容包。',
      '快捷回复': '沉淀高频问答，支持一键插入会话。',
      '会话记录': '展示客户会话摘要和重点跟进建议。',
      'AI 客户画像分析': '基于互动行为生成客户偏好与意向等级。',
      'AI 老客维护策略推荐': '针对老客户生命周期给出分层维护策略。',
    }

    const statData = {
      today: { chat: '1,280', customers: '436', aiRate: '78%', humanRate: '12%' },
      '7d': { chat: '8,920', customers: '2,138', aiRate: '75%', humanRate: '15%' },
      '30d': { chat: '34,600', customers: '8,406', aiRate: '73%', humanRate: '17%' },
    }

    const demoReplies = [
      '已为你生成一版温暖风格的营销开场文案（Demo）。',
      '建议结合客户标签补充一句专属利益点，可提升回复率（Demo）。',
      '可以再加入活动截止时间，增强行动驱动（Demo）。',
    ]

    const elements = {
      loginScreen: document.getElementById('login-screen'),
      appScreen: document.getElementById('app-screen'),
      loginForm: document.getElementById('login-form'),
      loginUsername: document.getElementById('login-username'),
      loginPassword: document.getElementById('login-password'),
      loginSubmit: document.getElementById('login-submit'),
      loginError: document.getElementById('login-error'),
      pageTitle: document.getElementById('page-title'),
      pageSubtitle: document.getElementById('page-subtitle'),
      navButtons: Array.from(document.querySelectorAll('.nav-btn')),
      pages: Array.from(document.querySelectorAll('.page')),
      logoutBtn: document.getElementById('logout-btn'),
      serviceStatus: document.getElementById('service-status'),
      bridgePhase: document.getElementById('bridge-phase'),
      bridgeMessage: document.getElementById('bridge-message'),
      bridgeUpdatedAt: document.getElementById('bridge-updated-at'),
      bridgeQrStatus: document.getElementById('bridge-qr-status'),
      bridgeLoginUser: document.getElementById('bridge-login-user'),
      bridgeQr: document.getElementById('bridge-qr'),
      verifyWrap: document.getElementById('verify-wrap'),
      verifyPrompt: document.getElementById('verify-prompt'),
      verifyForm: document.getElementById('verify-form'),
      verifyCode: document.getElementById('verify-code'),
      verifySubmit: document.getElementById('verify-submit'),
      verifyFeedback: document.getElementById('verify-feedback'),
      chatForm: document.getElementById('chat-form'),
      chatInput: document.getElementById('chat-input'),
      chatBox: document.getElementById('chat-box'),
      quickButtons: Array.from(document.querySelectorAll('[data-quick]')),
      assetSearch: document.getElementById('asset-search'),
      assetItems: Array.from(document.querySelectorAll('.asset-item')),
      toolButtons: Array.from(document.querySelectorAll('.tool-btn')),
      toolModalMask: document.getElementById('tool-modal-mask'),
      toolModalTitle: document.getElementById('tool-modal-title'),
      toolModalContent: document.getElementById('tool-modal-content'),
      toolModalClose: document.getElementById('tool-modal-close'),
      ragQuery: document.getElementById('rag-query'),
      ragSearch: document.getElementById('rag-search'),
      ragAdd: document.getElementById('rag-add'),
      ragFeedback: document.getElementById('rag-feedback'),
      tabButtons: Array.from(document.querySelectorAll('.tab-btn')),
      metricChat: document.getElementById('metric-chat'),
      metricCustomers: document.getElementById('metric-customers'),
      metricAiRate: document.getElementById('metric-ai-rate'),
      metricHumanRate: document.getElementById('metric-human-rate'),
      adminBridgePhase: document.getElementById('admin-bridge-phase'),
      adminWebStatus: document.getElementById('admin-web-status'),
      themeToggle: document.getElementById('theme-toggle'),
      notifyToggle: document.getElementById('notify-toggle'),
      adminFeedback: document.getElementById('admin-feedback'),
    }

    function setHidden (element, hidden) {
      if (!element) return
      element.classList.toggle('hidden', hidden)
    }

    function setText (element, value) {
      if (!element) return
      element.textContent = value
    }

    function setLoginError (message) {
      if (!message) {
        setText(elements.loginError, '')
        setHidden(elements.loginError, true)
        return
      }
      setText(elements.loginError, message)
      setHidden(elements.loginError, false)
    }

    function setVerifyFeedback (message, type) {
      if (!message) {
        elements.verifyFeedback.textContent = ''
        elements.verifyFeedback.className = 'hidden'
        return
      }
      elements.verifyFeedback.textContent = message
      elements.verifyFeedback.className = type
    }

    function showLoginScreen () {
      setHidden(elements.loginScreen, false)
      setHidden(elements.appScreen, true)
    }

    function showAppScreen () {
      setHidden(elements.loginScreen, true)
      setHidden(elements.appScreen, false)
    }

    function setActivePage (pageKey) {
      selectedPage = pageKey
      const meta = pageMeta[pageKey] || pageMeta.chat
      setText(elements.pageTitle, meta.title)
      setText(elements.pageSubtitle, meta.subtitle)
      elements.navButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.nav === pageKey)
      })
      elements.pages.forEach((page) => {
        page.classList.toggle('active', page.id === 'page-' + pageKey)
      })
    }

    function addChatMessage (text, role) {
      const item = document.createElement('div')
      item.className = 'chat-msg ' + role
      item.textContent = text
      elements.chatBox.appendChild(item)
      elements.chatBox.scrollTop = elements.chatBox.scrollHeight
    }

    function updateBridgeCards (status) {
      setText(elements.bridgePhase, status.phase)
      setText(elements.bridgeMessage, status.message)
      setText(elements.bridgeUpdatedAt, status.lastUpdatedAt)
      setText(elements.bridgeQrStatus, status.qrCodeStatus == null ? '-' : String(status.qrCodeStatus))
      const loginUser = status.loginUser == null
        ? '-'
        : [status.loginUser.name, status.loginUser.id].filter(Boolean).join(' / ') || '-'
      setText(elements.bridgeLoginUser, loginUser)
      setText(elements.adminBridgePhase, 'Bridge：' + status.phase)

      if (status.qrCodeSvg) {
        elements.bridgeQr.innerHTML = status.qrCodeSvg
      } else {
        elements.bridgeQr.innerHTML = '<span class="muted">当前没有可展示的二维码。</span>'
      }

      if (status.verifyCode && status.verifyCode.required) {
        latestRequestId = status.verifyCode.requestId
        setHidden(elements.verifyWrap, false)
        setText(elements.verifyPrompt, status.verifyCode.prompt)
        elements.verifySubmit.disabled = Boolean(status.verifyCode.submitting || status.verifyCode.submittedAt)
        if (status.verifyCode.submittedAt) {
          setVerifyFeedback('验证码已提交，请等待登录结果。', 'success')
        } else if (status.verifyCode.lastError) {
          setVerifyFeedback(status.verifyCode.lastError, 'error')
        } else {
          setVerifyFeedback('', '')
        }
      } else {
        latestRequestId = null
        setHidden(elements.verifyWrap, true)
        elements.verifyCode.value = ''
        setVerifyFeedback('', '')
      }

      const onlinePhases = ['ready', 'logged-in', 'verify-code-submitted', 'waiting-verify-code', 'waiting-scan']
      const statusLabel = onlinePhases.includes(status.phase) ? '服务状态：在线' : '服务状态：离线/启动中'
      setText(elements.serviceStatus, statusLabel)
    }

    async function fetchJson (url, options) {
      const response = await fetch(url, {
        ...options,
        credentials: 'same-origin',
        headers: {
          ...(options && options.headers ? options.headers : {}),
        },
      })
      const payload = await response.json().catch(() => ({}))
      return { response, payload }
    }

    async function ensureSession () {
      if (manualLoggedOut) {
        showLoginScreen()
        return false
      }
      const current = await fetchJson('/api/session', { method: 'GET' })
      if (current.response.ok) {
        csrfToken = current.payload.csrfToken
        showAppScreen()
        return true
      }
      if (bootstrap.tokenRequired) {
        showLoginScreen()
        return false
      }
      const created = await fetchJson('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!created.response.ok) {
        throw new Error(created.payload.error || '无法建立会话')
      }
      csrfToken = created.payload.csrfToken
      showAppScreen()
      return true
    }

    function connectEvents () {
      if (eventSource || !csrfToken || manualLoggedOut) {
        return
      }
      eventSource = new EventSource('/api/events')
      eventSource.onmessage = (event) => {
        updateBridgeCards(JSON.parse(event.data))
      }
      eventSource.onerror = () => {
        eventSource.close()
        eventSource = null
        setTimeout(() => {
          void refreshStatus().catch(() => {})
        }, 1500)
      }
    }

    async function refreshStatus () {
      const sessionReady = await ensureSession()
      if (!sessionReady) {
        return
      }
      const statusResponse = await fetchJson('/api/status', { method: 'GET' })
      if (statusResponse.response.status === 401) {
        csrfToken = null
        showLoginScreen()
        return
      }
      if (!statusResponse.response.ok) {
        throw new Error(statusResponse.payload.error || '无法获取状态')
      }
      updateBridgeCards(statusResponse.payload)
      connectEvents()
    }

    elements.navButtons.forEach((button) => {
      button.addEventListener('click', () => {
        setActivePage(button.dataset.nav || 'chat')
      })
    })

    elements.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      setLoginError('')
      const username = elements.loginUsername.value.trim()
      const password = elements.loginPassword.value
      if (username !== 'admin') {
        setLoginError('Demo 用户名固定为 admin。')
        return
      }
      elements.loginSubmit.disabled = true
      try {
        const created = await fetchJson('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: password }),
        })
        elements.loginPassword.value = ''
        if (!created.response.ok) {
          throw new Error(created.payload.error || '密码错误，请重试。')
        }
        csrfToken = created.payload.csrfToken
        manualLoggedOut = false
        showAppScreen()
        await refreshStatus()
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : String(error))
      } finally {
        elements.loginSubmit.disabled = false
      }
    })

    elements.logoutBtn.addEventListener('click', () => {
      manualLoggedOut = true
      csrfToken = null
      latestRequestId = null
      elements.loginPassword.value = ''
      setVerifyFeedback('', '')
      setLoginError('')
      if (eventSource) {
        eventSource.close()
        eventSource = null
      }
      showLoginScreen()
    })

    elements.verifyForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!csrfToken || !latestRequestId) {
        setVerifyFeedback('当前没有可提交的验证码请求。', 'error')
        return
      }
      elements.verifySubmit.disabled = true
      try {
        const sent = await fetchJson('/api/verify-code', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ requestId: latestRequestId, code: elements.verifyCode.value }),
        })
        elements.verifyCode.value = ''
        if (!sent.response.ok) {
          throw new Error(sent.payload.error || '验证码提交失败')
        }
        updateBridgeCards(sent.payload.status)
      } catch (error) {
        setVerifyFeedback(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        elements.verifySubmit.disabled = false
      }
    })

    elements.chatForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = elements.chatInput.value.trim()
      if (!value) {
        return
      }
      addChatMessage(value, 'user')
      const reply = demoReplies[Math.floor(Math.random() * demoReplies.length)]
      setTimeout(() => {
        addChatMessage(reply, 'ai')
      }, 250)
      elements.chatInput.value = ''
    })

    elements.quickButtons.forEach((button) => {
      button.addEventListener('click', () => {
        elements.chatInput.value = button.dataset.quick || ''
        elements.chatInput.focus()
      })
    })

    elements.assetSearch.addEventListener('input', () => {
      const keyword = elements.assetSearch.value.trim().toLowerCase()
      elements.assetItems.forEach((item) => {
        const text = (item.dataset.title + ' ' + item.dataset.tags).toLowerCase()
        item.classList.toggle('hidden', keyword !== '' && !text.includes(keyword))
      })
    })

    function openToolModal (name) {
      setText(elements.toolModalTitle, name)
      setText(elements.toolModalContent, toolDescriptions[name] || 'Demo 工具详情')
      setHidden(elements.toolModalMask, false)
      elements.toolModalClose.focus()
    }

    elements.toolButtons.forEach((button) => {
      button.addEventListener('click', () => {
        openToolModal(button.dataset.tool || '工具')
      })
    })

    function closeToolModal () {
      setHidden(elements.toolModalMask, true)
    }

    elements.toolModalClose.addEventListener('click', closeToolModal)
    elements.toolModalMask.addEventListener('click', (event) => {
      if (event.target === elements.toolModalMask) {
        closeToolModal()
      }
    })

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.toolModalMask.classList.contains('hidden')) {
        closeToolModal()
      }
    })

    function setRagFeedback (text) {
      setText(elements.ragFeedback, text)
    }

    elements.ragSearch.addEventListener('click', () => {
      const query = elements.ragQuery.value.trim()
      if (!query) {
        setRagFeedback('请输入关键词后再检索（Demo）。')
        return
      }
      setRagFeedback('已完成 “' + query + '” 的 Demo 检索，后端能力即将接入。')
    })

    elements.ragAdd.addEventListener('click', () => {
      setRagFeedback('已收到添加文档请求（Demo），当前不会持久化。')
    })

    elements.tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const range = button.dataset.range || 'today'
        const data = statData[range]
        if (!data) {
          return
        }
        elements.tabButtons.forEach((tab) => {
          tab.classList.toggle('active', tab === button)
        })
        setText(elements.metricChat, data.chat)
        setText(elements.metricCustomers, data.customers)
        setText(elements.metricAiRate, data.aiRate)
        setText(elements.metricHumanRate, data.humanRate)
      })
    })

    function updateAdminFeedback () {
      const themeText = elements.themeToggle.checked ? '暖色主题增强：开' : '暖色主题增强：关'
      const notifyText = elements.notifyToggle.checked ? '通知提醒：开' : '通知提醒：关'
      setText(elements.adminFeedback, themeText + '，' + notifyText + '（仅当前页面内存）')
    }

    elements.themeToggle.addEventListener('change', updateAdminFeedback)
    elements.notifyToggle.addEventListener('change', updateAdminFeedback)
    updateAdminFeedback()

    setActivePage(selectedPage)
    void refreshStatus().catch((error) => {
      showLoginScreen()
      setLoginError(error instanceof Error ? error.message : String(error))
    })
  </script>
</body>
</html>`
}


export class BridgeWebControlPlane {
  private readonly sessions = new Map<string, AuthSession>()
  private readonly listeners = new Set<http.ServerResponse>()
  private readonly tokenRequired: boolean
  private readonly server: http.Server
  private readonly state: ControlState

  constructor (
    private readonly config: BridgeWebConfig,
    private readonly bot: Wechaty,
    private readonly verifyCodeSubmitter: VerifyCodeSubmitter,
    private readonly logger: BridgeLoggerLike,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokenRequired = config.webToken !== ''
    this.state = {
      phase: 'starting',
      message: 'Bridge 正在启动，请稍候。',
      lastUpdatedAt: nowIso(this.now),
      qrCodeSvg: null,
      qrCodeStatus: null,
      qrCodeUpdatedAt: null,
      loginUser: null,
      verifyCode: null,
    }
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.server.on('error', (error) => {
      this.logger.error('bridge web control error', {
        errorCode: error.name,
        errorMessage: error.message,
      })
    })
    this.bindBotEvents()
  }

  get url (): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      return `http://${this.config.webHost}:${this.config.webPort}`
    }
    return `http://${address.address}:${address.port}`
  }

  async start (): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.webPort, this.config.webHost, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.logger.info('bridge web control listening', {
      host: this.config.webHost,
      port: this.config.webPort,
      tokenProtected: this.tokenRequired,
      verifyCodeSubmitMode: this.verifyCodeSubmitter.mode,
    })
  }

  async stop (): Promise<void> {
    this.clearVerifyCode('Bridge 已停止。', 'logged-out')
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private bindBotEvents (): void {
    this.bot.on('scan', (qrcode: string, status: number) => {
      void this.handleScan(qrcode, status)
    })
    this.bot.on('verify-code', (id: string, message: string, scene: number, status: number) => {
      this.handleVerifyCode(id, message, scene, status)
    })
    this.bot.on('login', (user: { id: string, name: () => string }) => {
      this.updateState({
        phase: 'logged-in',
        message: '扫码登录成功，请等待 Bridge 完成初始化。',
        loginUser: {
          id: maskIdentifier(user.id),
          name: user.name(),
        },
        qrCodeSvg: null,
        qrCodeStatus: null,
        qrCodeUpdatedAt: null,
        verifyCode: null,
      })
    })
    this.bot.on('ready', () => {
      this.updateState({
        phase: 'ready',
        message: 'Bridge 已 ready，可以开始处理消息。',
        qrCodeSvg: null,
        qrCodeStatus: null,
        qrCodeUpdatedAt: null,
        verifyCode: null,
      })
    })
    this.bot.on('logout', (user: { id: string, name: () => string }) => {
      this.clearVerifyCode(`已退出登录：${user.name()}`, 'logged-out')
      this.updateState({
        loginUser: {
          id: maskIdentifier(user.id),
          name: user.name(),
        },
      })
    })
    this.bot.on('error', () => {
      this.updateState({
        phase: 'error',
        message: 'Bridge 遇到异常，请检查服务器端 bridge 日志。',
        verifyCode: this.state.verifyCode,
      })
    })
  }

  private async handleScan (qrcode: string, status: number): Promise<void> {
    const qrCodeSvg = await QRCode.toString(qrcode, {
      errorCorrectionLevel: 'M',
      margin: 1,
      type: 'svg',
      width: 320,
    })
    this.updateState({
      phase: 'waiting-scan',
      message: '请使用企业微信测试员工账号扫码登录。',
      qrCodeSvg,
      qrCodeStatus: ScanStatus[status] ?? status,
      qrCodeUpdatedAt: nowIso(this.now),
    })
  }

  private handleVerifyCode (id: string, message: string, scene: number, status: number): void {
    if (this.state.verifyCode) {
      clearTimeout(this.state.verifyCode.timer)
    }
    const requestId = createToken()
    const expiresAtMs = this.now() + this.config.webVerifyTimeoutMs
    const timer = setTimeout(() => {
      void this.expireVerifyCode(requestId)
    }, this.config.webVerifyTimeoutMs)
    this.updateState({
      phase: 'waiting-verify-code',
      message: '请查看企业微信手机端并输入验证码。',
      verifyCode: {
        eventId: id,
        requestId,
        prompt: sanitizePrompt(message),
        scene,
        status,
        expiresAt: expiresAtMs,
        timer,
        submitting: false,
      },
    })
  }

  private async expireVerifyCode (requestId: string): Promise<void> {
    if (!this.state.verifyCode || this.state.verifyCode.requestId !== requestId) {
      return
    }
    const expired = this.state.verifyCode
    clearTimeout(expired.timer)
    this.updateState({
      phase: 'verify-code-expired',
      message: '验证码请求已超时，请重新扫码或等待新的验证码提示。',
      verifyCode: null,
      qrCodeSvg: null,
      qrCodeStatus: null,
      qrCodeUpdatedAt: null,
    })
    try {
      await this.verifyCodeSubmitter.cancel(expired.eventId)
    } catch {
      this.logger.warn('failed to cancel expired verify code request')
    }
  }

  private clearVerifyCode (message: string, phase: BridgePhase): void {
    if (this.state.verifyCode) {
      clearTimeout(this.state.verifyCode.timer)
    }
    this.updateState({
      phase,
      message,
      qrCodeSvg: null,
      qrCodeStatus: null,
      qrCodeUpdatedAt: null,
      verifyCode: null,
    })
  }

  private updateState (patch: Partial<ControlState>): void {
    if (patch.verifyCode !== this.state.verifyCode && this.state.verifyCode && patch.verifyCode == null) {
      clearTimeout(this.state.verifyCode.timer)
    }
    Object.assign(this.state, patch, { lastUpdatedAt: nowIso(this.now) })
    this.broadcast()
  }

  private snapshot (): StatusResponse {
    return {
      phase: this.state.phase,
      message: this.state.message,
      lastUpdatedAt: this.state.lastUpdatedAt,
      qrCodeSvg: this.state.qrCodeSvg,
      qrCodeStatus: this.state.qrCodeStatus,
      qrCodeUpdatedAt: this.state.qrCodeUpdatedAt,
      loginUser: this.state.loginUser,
      verifyCode: this.state.verifyCode == null
        ? null
        : {
            required: true,
            requestId: this.state.verifyCode.requestId,
            prompt: this.state.verifyCode.prompt,
            scene: this.state.verifyCode.scene,
            status: this.state.verifyCode.status,
            expiresAt: new Date(this.state.verifyCode.expiresAt).toISOString(),
            submitting: this.state.verifyCode.submitting,
            submittedAt: this.state.verifyCode.submittedAt ?? null,
            lastError: this.state.verifyCode.lastError ?? null,
          },
    }
  }

  private broadcast (): void {
    const data = `data: ${JSON.stringify(this.snapshot())}\n\n`
    for (const listener of this.listeners) {
      listener.write(data)
    }
  }

  private pruneExpiredSessions (): void {
    const current = this.now()
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= current) {
        this.sessions.delete(sessionId)
      }
    }
  }

  private getSession (request: http.IncomingMessage): { sessionId: string, session: AuthSession } | null {
    this.pruneExpiredSessions()
    const cookies = parseCookies(request.headers.cookie)
    const sessionId = cookies.bridge_web_session
    if (!sessionId) {
      return null
    }
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }
    session.expiresAt = this.now() + this.config.webSessionTtlMs
    return { sessionId, session }
  }

  private createSession (): { sessionId: string, csrfToken: string } {
    const sessionId = createToken()
    const csrfToken = createToken()
    this.sessions.set(sessionId, {
      csrfToken,
      expiresAt: this.now() + this.config.webSessionTtlMs,
    })
    return { sessionId, csrfToken }
  }

  private authorizeSessionRequest (request: http.IncomingMessage): { sessionId: string, session: AuthSession } | null {
    return this.getSession(request)
  }

  private async handleRequest (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        setNoStoreHeaders(response)
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(renderPage(this.tokenRequired))
        return
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, { ok: true, phase: this.state.phase })
        return
      }

      if (url.pathname === '/api/session' && request.method === 'GET') {
        const sessionRecord = this.getSession(request)
        if (!sessionRecord) {
          writeJson(response, 401, { error: 'authentication required' })
          return
        }
        writeJson(response, 200, { csrfToken: sessionRecord.session.csrfToken, tokenRequired: this.tokenRequired })
        return
      }

      if (url.pathname === '/api/session' && request.method === 'POST') {
        if (!isJsonRequest(request)) {
          writeJson(response, 415, { error: 'application/json required' })
          return
        }
        const payload = await readJsonBody<{ token?: string }>(request) ?? {}
        if (this.tokenRequired) {
          if (!safeCompare(payload.token?.trim() ?? '', this.config.webToken)) {
            writeJson(response, 401, { error: 'invalid bridge web token' })
            return
          }
        }
        const session = this.createSession()
        response.setHeader('Set-Cookie', `bridge_web_session=${encodeURIComponent(session.sessionId)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(this.config.webSessionTtlMs / 1000)}`)
        writeJson(response, 200, { csrfToken: session.csrfToken, tokenRequired: this.tokenRequired })
        return
      }

      if (url.pathname === '/api/status' && request.method === 'GET') {
        const sessionRecord = this.authorizeSessionRequest(request)
        if (!sessionRecord) {
          writeJson(response, 401, { error: 'authentication required' })
          return
        }
        writeJson(response, 200, this.snapshot())
        return
      }

      if (url.pathname === '/api/events' && request.method === 'GET') {
        const sessionRecord = this.authorizeSessionRequest(request)
        if (!sessionRecord) {
          writeJson(response, 401, { error: 'authentication required' })
          return
        }
        setNoStoreHeaders(response)
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        response.setHeader('Connection', 'keep-alive')
        response.setHeader('X-CSRF-Token', sessionRecord.session.csrfToken)
        response.write(`data: ${JSON.stringify(this.snapshot())}\n\n`)
        this.listeners.add(response)
        request.on('close', () => {
          this.listeners.delete(response)
        })
        return
      }

      if (url.pathname === '/api/verify-code' && request.method === 'POST') {
        const sessionRecord = this.authorizeSessionRequest(request)
        if (!sessionRecord) {
          writeJson(response, 401, { error: 'authentication required' })
          return
        }
        if (!isJsonRequest(request)) {
          writeJson(response, 415, { error: 'application/json required' })
          return
        }
        if (!isSameOrigin(request)) {
          writeJson(response, 403, { error: 'cross-site submit blocked' })
          return
        }
        if (!safeCompare(readSingleHeader(request.headers['x-csrf-token']), sessionRecord.session.csrfToken)) {
          writeJson(response, 403, { error: 'invalid csrf token' })
          return
        }
        const payload = await readJsonBody<{ code?: string, requestId?: string }>(request) ?? {}
        const code = payload.code?.trim() ?? ''
        if (!payload.requestId || !this.state.verifyCode) {
          writeJson(response, 409, { error: 'no active verify code request' })
          return
        }
        if (payload.requestId !== this.state.verifyCode.requestId) {
          writeJson(response, 409, { error: 'verify code request has been replaced' })
          return
        }
        if (this.state.verifyCode.submittedAt) {
          writeJson(response, 409, { error: 'verify code has already been submitted' })
          return
        }
        if (this.state.verifyCode.submitting) {
          writeJson(response, 409, { error: 'verify code submission already in progress' })
          return
        }
        if (code === '' || code.length > 32 || /\s/.test(code)) {
          writeJson(response, 400, { error: 'invalid verify code format' })
          return
        }

        const current = this.state.verifyCode
        current.submitting = true
        current.lastError = undefined
        this.updateState({ verifyCode: current })

        try {
          await this.verifyCodeSubmitter.submit(current.eventId, code)
          current.submitting = false
          current.submittedAt = nowIso(this.now)
          current.lastError = undefined
          this.updateState({
            phase: 'verify-code-submitted',
            message: '验证码已提交，请等待企业微信端完成登录。',
            verifyCode: current,
          })
          writeJson(response, 200, { ok: true, status: this.snapshot() })
        } catch {
          current.submitting = false
          current.lastError = '验证码提交失败，请核对后重试。'
          this.updateState({
            phase: 'waiting-verify-code',
            message: '请核对手机端验证码后重新提交。',
            verifyCode: current,
          })
          writeJson(response, 502, { error: current.lastError })
        }
        return
      }

      writeJson(response, 404, { error: `not found: ${escapeHtml(url.pathname)}` })
    } catch (error) {
      this.logger.error('bridge web request failed', {
        method: request.method,
        path: url.pathname,
        errorCode: error instanceof Error ? error.name : 'Error',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      writeJson(response, 500, { error: 'bridge web request failed' })
    }
  }
}
