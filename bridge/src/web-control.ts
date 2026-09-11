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
  <title>Wechaty Bridge 登录控制台</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f7fb; color: #1f2937; }
    main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); padding: 20px; margin-bottom: 16px; }
    h1, h2 { margin-top: 0; }
    .muted { color: #6b7280; }
    .hidden { display: none; }
    .status { font-size: 18px; font-weight: 600; }
    .qr { min-height: 256px; display: flex; align-items: center; justify-content: center; background: #f9fafb; border-radius: 12px; }
    .qr svg { width: min(100%, 320px); height: auto; }
    form { display: grid; gap: 12px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 12px; font-size: 16px; }
    button { border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 16px; padding: 10px 14px; cursor: pointer; }
    button[disabled] { opacity: 0.6; cursor: not-allowed; }
    code { background: #eef2ff; border-radius: 6px; padding: 2px 6px; }
    .error { color: #b91c1c; }
    .success { color: #047857; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Wechaty Bridge 登录控制台</h1>
      <p class="muted">请通过此页面查看二维码、跟踪登录状态，并在企业微信手机端要求时提交验证码。不要把验证码复制到日志、聊天或仓库中。</p>
    </div>

    <section id="auth-card" class="card hidden">
      <h2>访问验证</h2>
      <p class="muted">此页面受共享访问令牌保护。请从服务器环境变量 <code>BRIDGE_WEB_TOKEN</code> 获取后在此输入。</p>
      <form id="auth-form">
        <label>
          <span>访问令牌</span>
          <input id="auth-token" type="password" autocomplete="current-password" required>
        </label>
        <button id="auth-submit" type="submit">进入控制台</button>
      </form>
      <p id="auth-error" class="error hidden"></p>
    </section>

    <section id="status-card" class="card hidden">
      <h2>当前状态</h2>
      <p class="status" id="phase">正在加载…</p>
      <p id="message"></p>
      <p class="muted">最近更新：<span id="updated-at">-</span></p>
      <p class="muted">二维码状态：<span id="qr-status">-</span></p>
      <p class="muted">当前登录：<span id="login-user">-</span></p>
    </section>

    <section id="qr-card" class="card hidden">
      <h2>扫码二维码</h2>
      <div id="qr" class="qr"><span class="muted">等待二维码…</span></div>
      <p class="muted">若二维码失效，请等待新的 scan 事件推送后自动刷新。</p>
    </section>

    <section id="verify-card" class="card hidden">
      <h2>手机验证码</h2>
      <p id="verify-prompt"></p>
      <p class="muted">验证码只会通过受保护的 POST 请求提交，不会拼接到 URL。</p>
      <form id="verify-form">
        <label>
          <span>验证码</span>
          <input id="verify-code" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="32" required>
        </label>
        <button id="verify-submit" type="submit">提交验证码</button>
      </form>
      <p id="verify-feedback" class="hidden"></p>
    </section>
  </main>

  <script>
    const bootstrap = { tokenRequired: ${tokenRequired ? 'true' : 'false'} }
    let csrfToken = null
    let eventSource = null
    let latestRequestId = null

    const elements = {
      authCard: document.getElementById('auth-card'),
      authForm: document.getElementById('auth-form'),
      authToken: document.getElementById('auth-token'),
      authSubmit: document.getElementById('auth-submit'),
      authError: document.getElementById('auth-error'),
      statusCard: document.getElementById('status-card'),
      qrCard: document.getElementById('qr-card'),
      verifyCard: document.getElementById('verify-card'),
      phase: document.getElementById('phase'),
      message: document.getElementById('message'),
      updatedAt: document.getElementById('updated-at'),
      qrStatus: document.getElementById('qr-status'),
      loginUser: document.getElementById('login-user'),
      qr: document.getElementById('qr'),
      verifyPrompt: document.getElementById('verify-prompt'),
      verifyForm: document.getElementById('verify-form'),
      verifyCode: document.getElementById('verify-code'),
      verifySubmit: document.getElementById('verify-submit'),
      verifyFeedback: document.getElementById('verify-feedback'),
    }

    function setHidden (element, hidden) {
      element.classList.toggle('hidden', hidden)
    }

    function setText (element, value) {
      element.textContent = value
    }

    function setFeedback (message, type) {
      if (!message) {
        elements.verifyFeedback.textContent = ''
        elements.verifyFeedback.className = 'hidden'
        return
      }
      elements.verifyFeedback.textContent = message
      elements.verifyFeedback.className = type
    }

    function renderStatus (status) {
      setHidden(elements.statusCard, false)
      setHidden(elements.qrCard, false)
      setText(elements.phase, status.phase)
      setText(elements.message, status.message)
      setText(elements.updatedAt, status.lastUpdatedAt)
      setText(elements.qrStatus, status.qrCodeStatus == null ? '-' : String(status.qrCodeStatus))
      setText(
        elements.loginUser,
        status.loginUser == null
          ? '-'
          : [status.loginUser.name, status.loginUser.id].filter(Boolean).join(' / ') || '-',
      )

      if (status.qrCodeSvg) {
        elements.qr.innerHTML = status.qrCodeSvg
      } else {
        elements.qr.innerHTML = '<span class="muted">当前没有可展示的二维码。</span>'
      }

      if (status.verifyCode && status.verifyCode.required) {
        latestRequestId = status.verifyCode.requestId
        setHidden(elements.verifyCard, false)
        setText(elements.verifyPrompt, status.verifyCode.prompt)
        elements.verifySubmit.disabled = Boolean(status.verifyCode.submitting || status.verifyCode.submittedAt)
        if (status.verifyCode.submittedAt) {
          setFeedback('验证码已提交，请等待登录结果。', 'success')
        } else if (status.verifyCode.lastError) {
          setFeedback(status.verifyCode.lastError, 'error')
        } else {
          setFeedback('', '')
        }
      } else {
        latestRequestId = null
        setHidden(elements.verifyCard, true)
        elements.verifyCode.value = ''
        setFeedback('', '')
      }
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
      const { response, payload } = await fetchJson('/api/session', { method: 'GET' })
      if (response.ok) {
        csrfToken = payload.csrfToken
        setHidden(elements.authCard, true)
        return true
      }
      if (bootstrap.tokenRequired) {
        setHidden(elements.authCard, false)
        setHidden(elements.statusCard, true)
        setHidden(elements.qrCard, true)
        setHidden(elements.verifyCard, true)
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
      return true
    }

    async function refreshStatus () {
      const sessionReady = await ensureSession()
      if (!sessionReady) {
        return
      }
      const { response, payload } = await fetchJson('/api/status', { method: 'GET' })
      if (response.status === 401) {
        csrfToken = null
        await ensureSession()
        return
      }
      if (!response.ok) {
        throw new Error(payload.error || '无法获取状态')
      }
      renderStatus(payload)
      connectEvents()
    }

    function connectEvents () {
      if (eventSource || !csrfToken) {
        return
      }
      eventSource = new EventSource('/api/events')
      eventSource.onmessage = (event) => {
        renderStatus(JSON.parse(event.data))
      }
      eventSource.onerror = () => {
        eventSource.close()
        eventSource = null
        setTimeout(() => {
          void refreshStatus().catch((error) => {
            console.error(error)
          })
        }, 1500)
      }
    }

    elements.authForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      elements.authSubmit.disabled = true
      setHidden(elements.authError, true)
      try {
        const { response, payload } = await fetchJson('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: elements.authToken.value }),
        })
        if (!response.ok) {
          throw new Error(payload.error || '访问令牌无效')
        }
        csrfToken = payload.csrfToken
        elements.authToken.value = ''
        await refreshStatus()
      } catch (error) {
        setText(elements.authError, error instanceof Error ? error.message : String(error))
        setHidden(elements.authError, false)
      } finally {
        elements.authSubmit.disabled = false
      }
    })

    elements.verifyForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!csrfToken || !latestRequestId) {
        return
      }
      elements.verifySubmit.disabled = true
      try {
        const { response, payload } = await fetchJson('/api/verify-code', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ requestId: latestRequestId, code: elements.verifyCode.value }),
        })
        elements.verifyCode.value = ''
        if (!response.ok) {
          throw new Error(payload.error || '验证码提交失败')
        }
        renderStatus(payload.status)
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        elements.verifySubmit.disabled = false
      }
    })

    void refreshStatus().catch((error) => {
      console.error(error)
      setText(elements.phase, 'error')
      setText(elements.message, error instanceof Error ? error.message : String(error))
      setHidden(elements.statusCard, false)
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
