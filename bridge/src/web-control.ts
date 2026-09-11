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

function isTrustedProxyAddress (remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false
  }
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
}

function isSecureRequest (request: http.IncomingMessage): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted) {
    return true
  }
  if (!isTrustedProxyAddress(request.socket.remoteAddress)) {
    return false
  }
  const forwardedProto = readSingleHeader(request.headers['x-forwarded-proto']).toLowerCase()
  if (forwardedProto === '') {
    return false
  }
  return forwardedProto.split(',')[0]?.trim() === 'https'
}

function buildSessionCookie (request: http.IncomingMessage, sessionId: string, maxAgeSeconds: number): string {
  const attributes = [
    `bridge_web_session=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (isSecureRequest(request)) {
    attributes.push('Secure')
  }
  return attributes.join('; ')
}

function renderPage (tokenRequired: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>企微智能助手管理后台</title>
  <style>
    :root {
      --bg: #eef2f7;
      --surface: #ffffff;
      --surface-soft: #f7f9fc;
      --sidebar: #0c192b;
      --sidebar-soft: #15253a;
      --text: #172033;
      --muted: #667085;
      --line: #e4e9f0;
      --accent: #07a957;
      --accent-hover: #078f4b;
      --accent-soft: #eaf9f1;
      --warning: #d97706;
      --warning-soft: #fff7e8;
      --danger: #d92d20;
      --danger-soft: #fff0ee;
      --shadow: 0 22px 60px rgba(21, 34, 50, 0.12);
      --shadow-card: 0 8px 30px rgba(27, 39, 55, 0.06);
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 8% 0%, rgba(7, 169, 87, 0.09), transparent 28rem),
        var(--bg);
      font-family: "PingFang SC", "Microsoft YaHei", Inter, -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    button, input { font: inherit; }
    button:focus-visible, input:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 4px rgba(7, 169, 87, 0.16);
    }
    .hidden { display: none !important; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .page-shell { min-height: 100vh; padding: 24px; }
    .muted { color: var(--muted); }
    .eyebrow {
      margin: 0 0 9px;
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
    }

    .brand-mark {
      position: relative;
      z-index: 1;
      display: grid;
      width: 58px;
      height: 58px;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 18px;
      color: #fff;
      background: linear-gradient(145deg, #14ce71, #06964c);
      box-shadow: 0 12px 28px rgba(7, 169, 87, 0.25);
    }
    .brand-mark svg {
      width: 31px;
      height: 31px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.7;
    }
    .brand-mark.small {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      box-shadow: 0 8px 20px rgba(7, 169, 87, 0.2);
    }
    .brand-mark.small svg { width: 24px; height: 24px; }

    .login-wrap {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(400px, 0.92fr);
      width: min(1040px, 100%);
      min-height: min(650px, calc(100vh - 48px));
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.7);
      border-radius: 28px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .login-brand-panel {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: center;
      overflow: hidden;
      padding: 64px;
      color: #fff;
      background:
        radial-gradient(circle at 82% 18%, rgba(35, 224, 133, 0.23), transparent 16rem),
        linear-gradient(145deg, #0d1c31, #102943);
    }
    .login-brand-panel::before,
    .login-brand-panel::after {
      position: absolute;
      content: "";
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 50%;
    }
    .login-brand-panel::before { width: 360px; height: 360px; top: -180px; right: -130px; }
    .login-brand-panel::after { width: 280px; height: 280px; bottom: -170px; left: -110px; }
    .login-brand-panel > div { position: relative; z-index: 1; }
    .login-brand-panel .brand-mark { margin-bottom: 38px; }
    .login-brand-panel .eyebrow { color: #61e5a5; }
    .login-brand-panel h1 {
      margin: 0 0 18px;
      font-size: clamp(36px, 4vw, 48px);
      line-height: 1.18;
      letter-spacing: -0.04em;
    }
    .login-brand-panel > div > p:last-child {
      max-width: 390px;
      margin: 0;
      color: #aebdd0;
      font-size: 16px;
      line-height: 1.8;
    }
    .login-feature-list {
      display: grid;
      gap: 14px;
      margin-top: 58px;
      color: #dbe5ef;
      font-size: 14px;
    }
    .login-feature-list span { display: flex; align-items: center; gap: 12px; }
    .login-feature-list i {
      display: grid;
      width: 29px;
      height: 29px;
      place-items: center;
      border: 1px solid rgba(97, 229, 165, 0.24);
      border-radius: 9px;
      color: #61e5a5;
      font-size: 10px;
      font-style: normal;
    }
    .login-card {
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 64px;
      background: var(--surface);
    }
    .login-kicker {
      align-self: flex-start;
      margin-bottom: 18px;
      padding: 6px 10px;
      border-radius: 7px;
      color: var(--accent);
      background: var(--accent-soft);
      font-size: 12px;
      font-weight: 700;
    }
    .login-title {
      margin: 0 0 10px;
      font-size: 32px;
      line-height: 1.2;
      letter-spacing: -0.03em;
    }
    .login-card > .muted { margin: 0; font-size: 14px; }
    .login-form { display: grid; gap: 20px; margin-top: 36px; }
    .field { display: grid; gap: 9px; }
    .field label { color: #344054; font-size: 13px; font-weight: 600; }
    .input {
      width: 100%;
      height: 48px;
      padding: 0 14px;
      border: 1px solid #d7dde6;
      border-radius: 10px;
      color: var(--text);
      background: #fff;
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .input:hover { border-color: #b8c2cf; }
    .input:focus { border-color: var(--accent); outline: 0; }
    .input[readonly] { color: #667085; background: #f6f8fa; }
    .input::placeholder { color: #98a2b3; }
    .btn {
      display: inline-flex;
      min-height: 42px;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 0 18px;
      border: 1px solid transparent;
      border-radius: 10px;
      color: #fff;
      background: var(--accent);
      font-weight: 600;
      cursor: pointer;
      transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:active { transform: translateY(1px); }
    .btn[disabled] { opacity: 0.58; cursor: not-allowed; }
    .btn-secondary {
      min-height: 40px;
      color: #344054;
      background: #fff;
      border-color: var(--line);
      font-size: 13px;
    }
    .btn-secondary:hover { border-color: #cbd3dd; background: #f9fafb; }
    .login-submit { height: 50px; margin-top: 4px; }
    .login-submit span { font-size: 19px; font-weight: 400; }
    .login-hint {
      margin: 28px 0 0;
      color: #98a2b3;
      font-size: 12px;
      line-height: 1.6;
      text-align: center;
    }
    .form-message { margin: 14px 0 0; font-size: 13px; }
    .error { color: var(--danger); }
    .success { color: var(--accent); }

    .app {
      display: grid;
      grid-template-columns: 276px minmax(0, 1fr);
      width: min(1500px, 100%);
      min-height: calc(100vh - 48px);
      margin: 0 auto;
      overflow: hidden;
      border-radius: 24px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      min-width: 0;
      padding: 30px 24px;
      color: #fff;
      background:
        radial-gradient(circle at 18% 90%, rgba(7, 169, 87, 0.12), transparent 16rem),
        var(--sidebar);
    }
    .brand { display: flex; align-items: center; gap: 13px; }
    .brand h1 { margin: 0; font-size: 16px; letter-spacing: -0.01em; }
    .brand p { margin: 5px 0 0; color: #8191a6; font-size: 12px; }
    .sidebar-section { margin-top: 54px; }
    .sidebar-label {
      margin: 0 0 12px;
      color: #718299;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
    }
    .status-overview {
      padding: 20px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.045);
    }
    .status-heading { display: flex; align-items: center; gap: 10px; }
    .status-heading strong { font-size: 15px; }
    .status-dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border: 2px solid transparent;
      border-radius: 50%;
      background: #8090a5;
      box-shadow: 0 0 0 4px rgba(128, 144, 165, 0.13);
    }
    .status-dot.success { background: #24d67b; box-shadow: 0 0 0 4px rgba(36, 214, 123, 0.14); }
    .status-dot.warning { background: #f6ad45; box-shadow: 0 0 0 4px rgba(246, 173, 69, 0.14); }
    .status-dot.danger { background: #f97066; box-shadow: 0 0 0 4px rgba(249, 112, 102, 0.14); }
    .status-overview > p {
      margin: 10px 0 0;
      color: #8999ad;
      font-size: 12px;
      line-height: 1.65;
    }
    .status-divider { height: 1px; margin: 18px 0; background: rgba(255, 255, 255, 0.08); }
    .account-label { display: block; color: #718299; font-size: 11px; }
    .account-name {
      display: block;
      overflow: hidden;
      margin-top: 7px;
      color: #dce5ef;
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sidebar-foot {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-top: auto;
      padding: 18px;
      border-radius: 13px;
      color: #b7c3d1;
      background: rgba(255, 255, 255, 0.04);
    }
    .sidebar-foot .secure-icon {
      display: grid;
      width: 20px;
      height: 20px;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 50%;
      color: #0d2b20;
      background: #4ad693;
      font-size: 11px;
      font-weight: 800;
    }
    .sidebar-foot strong { display: block; font-size: 12px; }
    .sidebar-foot p { margin: 4px 0 0; color: #718299; font-size: 10px; line-height: 1.5; }

    .content {
      min-width: 0;
      padding: 34px 38px 38px;
      background: var(--surface-soft);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 30px;
    }
    .topbar h2 { margin: 0; font-size: 28px; letter-spacing: -0.035em; }
    .page-subtitle { margin: 9px 0 0; color: var(--muted); font-size: 13px; }
    .top-meta { display: flex; align-items: center; gap: 10px; }
    .status-pill,
    .phase-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: #667085;
      background: #fff;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .status-pill { min-height: 40px; padding: 0 14px; }
    .status-pill i,
    .live-mark i {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #98a2b3;
    }
    .status-pill.success { color: #087443; border-color: #cceedd; background: #f4fcf8; }
    .status-pill.success i { background: var(--accent); }
    .status-pill.warning { color: #a45d09; border-color: #f3dfbb; background: #fffbf3; }
    .status-pill.warning i { background: var(--warning); }
    .status-pill.danger { color: #b42318; border-color: #f2cbc7; background: #fff7f6; }
    .status-pill.danger i { background: var(--danger); }

    .content-grid {
      display: grid;
      grid-template-columns: minmax(460px, 1.5fr) minmax(300px, 0.86fr);
      gap: 22px;
      align-items: start;
    }
    .connection-card,
    .detail-card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--surface);
      box-shadow: var(--shadow-card);
    }
    .connection-card { min-height: 590px; padding: 28px; }
    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
    }
    .section-kicker {
      display: block;
      margin-bottom: 8px;
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .section-head h3 { margin: 0; font-size: 20px; letter-spacing: -0.025em; }
    .phase-badge { padding: 6px 10px; }
    .phase-badge.success { color: #087443; border-color: #cceedd; background: var(--accent-soft); }
    .phase-badge.warning { color: #a45d09; border-color: #f1dab2; background: var(--warning-soft); }
    .phase-badge.danger { color: #b42318; border-color: #f2cbc7; background: var(--danger-soft); }
    .connection-message {
      min-height: 22px;
      margin: 13px 0 22px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.65;
    }
    .bridge-qr {
      display: flex;
      min-height: 390px;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 14px;
      overflow: hidden;
      padding: 30px;
      border: 1px dashed #d9e0e9;
      border-radius: 15px;
      color: #98a2b3;
      background:
        linear-gradient(rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.8)),
        repeating-linear-gradient(45deg, #f4f7fa 0, #f4f7fa 8px, #fff 8px, #fff 16px);
      font-size: 12px;
    }
    .bridge-qr .qr-image { width: min(100%, 310px); height: auto; }
    .empty-qr {
      display: grid;
      width: 68px;
      height: 68px;
      place-items: center;
      border-radius: 18px;
      color: #a5b0bd;
      background: #edf1f5;
    }
    .empty-qr svg {
      width: 32px;
      height: 32px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.5;
    }
    .verify-panel {
      margin-top: 18px;
      padding: 17px;
      border: 1px solid #f2ddba;
      border-radius: 13px;
      background: var(--warning-soft);
    }
    .verify-copy { display: flex; align-items: flex-start; gap: 10px; }
    .verify-copy p { margin: 1px 0 0; color: #875114; font-size: 12px; line-height: 1.6; }
    .verify-icon {
      display: grid;
      width: 20px;
      height: 20px;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 50%;
      color: #fff;
      background: var(--warning);
      font-size: 12px;
      font-weight: 800;
    }
    .verify-form { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-top: 13px; }
    .verify-form .input { height: 42px; background: #fff; }

    .detail-column { display: grid; gap: 18px; }
    .detail-card { padding: 22px; }
    .detail-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .detail-card h3 { margin: 0; font-size: 15px; }
    .live-mark {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #98a2b3;
      font-size: 10px;
    }
    .live-mark i { background: var(--accent); }
    .detail-list { margin: 18px 0 0; }
    .detail-list > div {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      padding: 14px 0;
      border-top: 1px solid #edf0f4;
      font-size: 12px;
    }
    .detail-list dt { color: #98a2b3; }
    .detail-list dd {
      max-width: 65%;
      margin: 0;
      overflow-wrap: anywhere;
      color: #344054;
      font-weight: 600;
      text-align: right;
    }
    .steps { display: grid; gap: 18px; margin: 22px 0 0; padding: 0; list-style: none; }
    .steps li { display: grid; grid-template-columns: 28px 1fr; gap: 12px; align-items: start; }
    .steps li > span {
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
      border-radius: 9px;
      color: var(--accent);
      background: var(--accent-soft);
      font-size: 11px;
      font-weight: 700;
    }
    .steps p { margin: 0; color: #98a2b3; font-size: 11px; line-height: 1.55; }
    .steps strong { display: block; margin-bottom: 3px; color: #475467; font-size: 12px; }
    .notice-card {
      display: grid;
      grid-template-columns: 25px 1fr;
      gap: 11px;
      padding: 18px;
      border: 1px solid #dcebe4;
      border-radius: 14px;
      background: #f2faf6;
    }
    .notice-card > span {
      display: grid;
      width: 22px;
      height: 22px;
      place-items: center;
      border: 1px solid #93d8b6;
      border-radius: 50%;
      color: #087443;
      font-size: 12px;
      font-weight: 700;
    }
    .notice-card p { margin: 0; color: #5b7468; font-size: 11px; line-height: 1.65; }
    .notice-card strong { display: block; margin-bottom: 3px; color: #296147; font-size: 12px; }

    @media (max-width: 1080px) {
      .content-grid { grid-template-columns: 1fr; }
      .detail-column { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .notice-card { grid-column: 1 / -1; }
    }
    @media (max-width: 820px) {
      .page-shell { padding: 12px; }
      .login-wrap { grid-template-columns: 1fr; min-height: calc(100vh - 24px); }
      .login-brand-panel { display: none; }
      .login-card { padding: 44px; }
      .app { grid-template-columns: 1fr; min-height: calc(100vh - 24px); }
      .sidebar { padding: 22px; }
      .sidebar-section { margin-top: 28px; }
      .status-overview { display: grid; grid-template-columns: 1fr auto; gap: 5px 20px; align-items: center; }
      .status-overview > p { grid-column: 1; }
      .status-divider { display: none; }
      .account-label { grid-column: 2; grid-row: 1; text-align: right; }
      .account-name { grid-column: 2; grid-row: 2; text-align: right; }
      .sidebar-foot { display: none; }
      .content { padding: 28px 22px; }
    }
    @media (max-width: 600px) {
      .login-card { padding: 32px 24px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .top-meta { width: 100%; justify-content: space-between; }
      .status-pill { padding: 0 11px; }
      .connection-card { min-height: auto; padding: 20px; }
      .section-head { align-items: flex-start; flex-direction: column; gap: 12px; }
      .bridge-qr { min-height: 310px; padding: 18px; }
      .verify-form { grid-template-columns: 1fr; }
      .detail-column { grid-template-columns: 1fr; }
      .notice-card { grid-column: auto; }
    }
  </style>
</head>
<body>
  <main class="page-shell">
    <section id="login-screen" class="login-wrap">
      <div class="login-brand-panel">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3v-3h-2A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4Z"/><path d="M8 9h8M8 12.5h5"/></svg>
        </span>
        <div>
          <p class="eyebrow">WECOM AI ASSISTANT</p>
          <h1>企微智能助手</h1>
          <p>集中查看企业微信接入状态，安全完成扫码与验证。</p>
        </div>
        <div class="login-feature-list" aria-label="控制台能力">
          <span><i>01</i> 实时连接状态</span>
          <span><i>02</i> 企业微信扫码登录</span>
          <span><i>03</i> 安全验证码提交</span>
        </div>
      </div>
      <article class="login-card">
        <span class="login-kicker">管理后台</span>
        <h2 class="login-title">欢迎回来</h2>
        <p class="muted">请使用管理凭据登录控制台。</p>
        <form id="login-form" class="login-form">
          <div class="field">
            <label for="login-username">管理员账号</label>
            <input id="login-username" class="input" type="text" value="admin" readonly required>
          </div>
          <div class="field">
            <label for="login-password">访问密码</label>
            <input id="login-password" class="input" type="password" autocomplete="current-password" placeholder="输入 BRIDGE_WEB_TOKEN" required>
          </div>
          <button id="login-submit" class="btn login-submit" type="submit">
            进入管理后台
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <p id="login-error" class="form-message error hidden"></p>
        <p class="login-hint">账号固定为 admin，访问密码由服务端安全校验。</p>
      </article>
    </section>

    <section id="app-screen" class="app hidden" aria-live="polite">
      <aside class="sidebar">
        <header class="brand">
          <span class="brand-mark small" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3v-3h-2A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4Z"/><path d="M8 9h8M8 12.5h5"/></svg>
          </span>
          <div>
            <h1>企微智能助手</h1>
            <p>管理后台</p>
          </div>
        </header>

        <div class="sidebar-section">
          <p class="sidebar-label">当前登录状态</p>
          <div class="status-overview">
            <div class="status-heading">
              <span id="sidebar-status-dot" class="status-dot neutral" aria-hidden="true"></span>
              <strong id="sidebar-status-text">正在连接</strong>
            </div>
            <p id="sidebar-status-message">正在获取企业微信连接状态。</p>
            <div class="status-divider"></div>
            <span class="account-label">企业微信账号</span>
            <strong id="sidebar-login-user" class="account-name">尚未登录</strong>
          </div>
        </div>

        <footer class="sidebar-foot">
          <span class="secure-icon" aria-hidden="true">✓</span>
          <div>
            <strong>安全连接</strong>
            <p>敏感凭据不会在页面展示</p>
          </div>
        </footer>
      </aside>

      <section class="content">
        <header class="topbar">
          <div>
            <p class="eyebrow">CONNECTION MANAGEMENT</p>
            <h2>企业微信接入</h2>
            <p class="page-subtitle">查看并管理智能助手的企业微信登录连接。</p>
          </div>
          <div class="top-meta">
            <span id="service-status" class="status-pill neutral"><i></i>Bridge 正在连接</span>
            <button id="logout-btn" type="button" class="btn btn-secondary">退出后台</button>
          </div>
        </header>

        <div class="content-grid">
          <article class="connection-card">
            <div class="section-head">
              <div>
                <span class="section-kicker">企业微信登录</span>
                <h3 id="connection-title">等待企业微信连接</h3>
              </div>
              <span class="phase-badge neutral" id="bridge-phase">正在启动</span>
            </div>
            <p id="bridge-message" class="connection-message">Bridge 正在启动，请稍候。</p>

            <div id="bridge-qr" class="bridge-qr">
              <div class="empty-qr" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8h8v8H8z"/></svg>
              </div>
              <span>二维码生成后将在这里显示</span>
            </div>

            <div id="verify-wrap" class="verify-panel hidden">
              <div class="verify-copy">
                <span class="verify-icon" aria-hidden="true">!</span>
                <p id="verify-prompt">请在企业微信手机端查看验证码。</p>
              </div>
              <form id="verify-form" class="verify-form">
                <label class="sr-only" for="verify-code">企业微信验证码</label>
                <input id="verify-code" class="input" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="输入验证码" required>
                <button id="verify-submit" class="btn" type="submit">提交验证</button>
              </form>
              <p id="verify-feedback" class="form-message hidden"></p>
            </div>
          </article>

          <div class="detail-column">
            <article class="detail-card">
              <div class="detail-card-head">
                <h3>连接详情</h3>
                <span class="live-mark"><i></i>实时更新</span>
              </div>
              <dl class="detail-list">
                <div>
                  <dt>当前账号</dt>
                  <dd id="bridge-login-user">未登录</dd>
                </div>
                <div>
                  <dt>二维码状态</dt>
                  <dd id="bridge-qr-status">-</dd>
                </div>
                <div>
                  <dt>最后更新</dt>
                  <dd id="bridge-updated-at">-</dd>
                </div>
              </dl>
            </article>

            <article class="detail-card guide-card">
              <h3>登录指引</h3>
              <ol class="steps">
                <li><span>1</span><p><strong>打开企业微信</strong>使用测试员工账号进入扫码功能</p></li>
                <li><span>2</span><p><strong>扫描登录二维码</strong>在手机端确认本次登录</p></li>
                <li><span>3</span><p><strong>完成安全验证</strong>如有验证码，请在本页提交</p></li>
              </ol>
            </article>

            <article class="notice-card">
              <span aria-hidden="true">i</span>
              <p><strong>连接说明</strong>二维码与验证码仅用于建立 Bridge 会话，不会记录或展示访问令牌。</p>
            </article>
          </div>
        </div>
      </section>
    </section>
  </main>

  <script>
    const bootstrap = { tokenRequired: ${tokenRequired ? 'true' : 'false'} }
    let csrfToken = null
    let eventSource = null
    let latestRequestId = null
    let manualLoggedOut = false
    let reconnectTimer = null

    const phaseMeta = {
      starting: { label: '正在启动', title: '等待企业微信连接', tone: 'neutral' },
      'waiting-scan': { label: '等待扫码', title: '使用企业微信扫码登录', tone: 'warning' },
      'waiting-verify-code': { label: '等待验证', title: '完成企业微信安全验证', tone: 'warning' },
      'verify-code-submitted': { label: '正在验证', title: '正在确认验证码', tone: 'warning' },
      'verify-code-expired': { label: '验证超时', title: '请重新扫码登录', tone: 'danger' },
      'logged-in': { label: '已登录', title: '企业微信登录成功', tone: 'success' },
      ready: { label: '运行中', title: '企业微信连接正常', tone: 'success' },
      'logged-out': { label: '未登录', title: '企业微信已退出', tone: 'neutral' },
      error: { label: '连接异常', title: '企业微信连接异常', tone: 'danger' },
    }

    const elements = {
      loginScreen: document.getElementById('login-screen'),
      appScreen: document.getElementById('app-screen'),
      loginForm: document.getElementById('login-form'),
      loginUsername: document.getElementById('login-username'),
      loginPassword: document.getElementById('login-password'),
      loginSubmit: document.getElementById('login-submit'),
      loginError: document.getElementById('login-error'),
      logoutBtn: document.getElementById('logout-btn'),
      serviceStatus: document.getElementById('service-status'),
      sidebarStatusDot: document.getElementById('sidebar-status-dot'),
      sidebarStatusText: document.getElementById('sidebar-status-text'),
      sidebarStatusMessage: document.getElementById('sidebar-status-message'),
      sidebarLoginUser: document.getElementById('sidebar-login-user'),
      connectionTitle: document.getElementById('connection-title'),
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
        elements.verifyFeedback.className = 'form-message hidden'
        return
      }
      elements.verifyFeedback.textContent = message
      elements.verifyFeedback.className = 'form-message ' + type
    }

    function showLoginScreen () {
      setHidden(elements.loginScreen, false)
      setHidden(elements.appScreen, true)
    }

    function showAppScreen () {
      setHidden(elements.loginScreen, true)
      setHidden(elements.appScreen, false)
    }

    function setTone (element, tone) {
      element.classList.remove('neutral', 'success', 'warning', 'danger')
      element.classList.add(tone)
    }

    function renderQrPlaceholder (message) {
      const icon = document.createElement('div')
      icon.className = 'empty-qr'
      icon.setAttribute('aria-hidden', 'true')
      icon.textContent = '⌁'
      const label = document.createElement('span')
      label.textContent = message
      elements.bridgeQr.replaceChildren(icon, label)
    }

    function formatUpdatedAt (value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) {
        return value || '-'
      }
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    function updateBridgeCards (status) {
      const meta = phaseMeta[status.phase] || { label: status.phase, title: '企业微信连接状态', tone: 'neutral' }
      const loginUser = status.loginUser == null
        ? ''
        : [status.loginUser.name, status.loginUser.id].filter(Boolean).join(' / ')
      const isLoggedIn = ['ready', 'logged-in'].includes(status.phase)
      const displayedUser = isLoggedIn && loginUser ? loginUser : '未登录'
      const qrStatusLabels = {
        Waiting: '等待扫码',
        Scanned: '已扫码',
        Confirmed: '已确认',
        Timeout: '已过期',
        Canceled: '已取消',
        Cancelled: '已取消',
      }
      const qrStatus = status.qrCodeStatus == null
        ? '-'
        : (qrStatusLabels[String(status.qrCodeStatus)] || String(status.qrCodeStatus))

      setText(elements.connectionTitle, meta.title)
      setText(elements.bridgePhase, meta.label)
      setText(elements.bridgeMessage, status.message)
      setText(elements.bridgeUpdatedAt, formatUpdatedAt(status.lastUpdatedAt))
      setText(elements.bridgeQrStatus, qrStatus)
      setText(elements.bridgeLoginUser, displayedUser)
      setText(elements.sidebarStatusText, meta.label)
      setText(elements.sidebarStatusMessage, status.message)
      setText(elements.sidebarLoginUser, displayedUser === '未登录' ? '尚未登录' : displayedUser)
      setTone(elements.bridgePhase, meta.tone)
      setTone(elements.sidebarStatusDot, meta.tone)
      setTone(elements.serviceStatus, meta.tone)
      elements.serviceStatus.replaceChildren(
        document.createElement('i'),
        document.createTextNode('Bridge · ' + meta.label),
      )

      if (typeof status.qrCodeSvg === 'string' && status.qrCodeSvg.trim() !== '') {
        renderQrSvgAsImage(status.qrCodeSvg)
      } else {
        const placeholder = isLoggedIn
          ? '当前已登录，无需扫描二维码'
          : status.phase === 'error'
            ? '等待 Bridge 恢复后重新生成二维码'
            : '二维码生成后将在这里显示'
        renderQrPlaceholder(placeholder)
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

    }

    function renderQrSvgAsImage (svg) {
      try {
        const bytes = new TextEncoder().encode(svg)
        let binary = ''
        for (const value of bytes) {
          binary += String.fromCharCode(value)
        }
        const image = document.createElement('img')
        image.alt = 'Bridge 登录二维码'
        image.src = 'data:image/svg+xml;base64,' + btoa(binary)
        image.className = 'qr-image'
        elements.bridgeQr.replaceChildren(image)
      } catch {
        renderQrPlaceholder('二维码渲染失败，请等待刷新')
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
        if (reconnectTimer != null) {
          clearTimeout(reconnectTimer)
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          void refreshStatus().catch(() => {})
        }, 1500)
      }
    }

    async function refreshStatus (allowRetry = true) {
      const sessionReady = await ensureSession()
      if (!sessionReady) {
        return
      }
      const statusResponse = await fetchJson('/api/status', { method: 'GET' })
      if (statusResponse.response.status === 401) {
        if (eventSource) {
          eventSource.close()
          eventSource = null
        }
        csrfToken = null
        if (bootstrap.tokenRequired) {
          manualLoggedOut = false
          showLoginScreen()
          return
        }
        if (allowRetry) {
          await refreshStatus(false)
          return
        }
        throw new Error('控制台会话初始化失败，请检查 Bridge 服务状态。')
        return
      }
      if (!statusResponse.response.ok) {
        throw new Error(statusResponse.payload.error || '无法获取状态')
      }
      updateBridgeCards(statusResponse.payload)
      connectEvents()
    }

    elements.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      setLoginError('')
      const username = elements.loginUsername.value.trim()
      const password = elements.loginPassword.value
      if (username !== 'admin') {
        setLoginError('管理员账号固定为 admin。')
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

    function applyLogoutState () {
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
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      showLoginScreen()
    }

    elements.logoutBtn.addEventListener('click', async () => {
      elements.logoutBtn.disabled = true
      try {
        if (csrfToken) {
          const destroyed = await fetchJson('/api/session', {
            method: 'DELETE',
            headers: {
              'X-CSRF-Token': csrfToken,
            },
          })
          if (!destroyed.response.ok) {
            throw new Error(destroyed.payload.error || '退出失败，请重试。')
          }
        }
        applyLogoutState()
      } catch (error) {
        setText(elements.bridgeMessage, error instanceof Error ? error.message : String(error))
      } finally {
        elements.logoutBtn.disabled = false
      }
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

    void refreshStatus().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (bootstrap.tokenRequired) {
        showLoginScreen()
        setLoginError(message)
        return
      }
      showAppScreen()
      setTone(elements.serviceStatus, 'danger')
      elements.serviceStatus.replaceChildren(
        document.createElement('i'),
        document.createTextNode('Bridge · 初始化失败'),
      )
      setText(elements.bridgeMessage, message)
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
        response.setHeader('Set-Cookie', buildSessionCookie(
          request,
          session.sessionId,
          Math.floor(this.config.webSessionTtlMs / 1000),
        ))
        writeJson(response, 200, { csrfToken: session.csrfToken, tokenRequired: this.tokenRequired })
        return
      }

      if (url.pathname === '/api/session' && request.method === 'DELETE') {
        const sessionRecord = this.authorizeSessionRequest(request)
        if (!sessionRecord) {
          writeJson(response, 401, { error: 'authentication required' })
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
        this.sessions.delete(sessionRecord.sessionId)
        response.setHeader('Set-Cookie', buildSessionCookie(request, '', 0))
        writeJson(response, 200, { ok: true })
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
