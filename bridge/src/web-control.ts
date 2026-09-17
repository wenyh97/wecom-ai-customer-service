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

const BRIDGE_CONSOLE_ROUTE_ALIASES = {
  chat: 'account',
  account: 'account',
  'account-link': 'account',
  assets: 'tools',
  'content-assets': 'tools',
  tools: 'tools',
  rag: 'rag',
  stats: 'stats',
  admin: 'model-config',
  model: 'model-config',
  'model-config': 'model-config',
  people: 'people',
  teams: 'teams',
  permissions: 'permissions',
} as const

type BridgeConsolePage = typeof BRIDGE_CONSOLE_ROUTE_ALIASES[keyof typeof BRIDGE_CONSOLE_ROUTE_ALIASES]
type BridgeConsoleToolGroup = 'operations'

export interface BridgeConsoleRoute {
  page: BridgeConsolePage
  toolGroup: BridgeConsoleToolGroup
  scrollToAssets: boolean
}

export function normalizeBridgeConsolePage (raw: string | null | undefined): BridgeConsolePage {
  const normalized = String(raw ?? '').trim().replace(/^#+/, '').toLowerCase()
  return BRIDGE_CONSOLE_ROUTE_ALIASES[normalized as keyof typeof BRIDGE_CONSOLE_ROUTE_ALIASES] ?? 'account'
}

export function deriveBridgeConsoleRoute (
  hash: string | null | undefined,
  queryPage: string | null | undefined,
): BridgeConsoleRoute {
  const hashValue = String(hash ?? '').trim().replace(/^#+/, '').toLowerCase()
  const queryValue = String(queryPage ?? '').trim().toLowerCase()
  const raw = hashValue || queryValue || 'account'
  const scrollToAssets = raw === 'assets' || raw === 'content-assets'
  return {
    page: normalizeBridgeConsolePage(raw),
    toolGroup: 'operations',
    scrollToAssets,
  }
}

export interface BridgeModelConfigState {
  provider: string
  baseUrl: string
  model: string
  timeoutMs: string
  enabled: boolean
  apiKeyConfigured: boolean
}

export interface BridgeModelConfigSubmission {
  provider: string
  baseUrl: string
  model: string
  timeoutMs: string
  enabled: boolean
  apiKeyValue: string
  clearApiKey: boolean
}

export function computeBridgeModelConfigState (
  current: BridgeModelConfigState,
  submission: BridgeModelConfigSubmission,
): BridgeModelConfigState {
  const apiKeyValue = submission.apiKeyValue.trim()
  return {
    ...current,
    provider: submission.provider,
    baseUrl: submission.baseUrl.trim(),
    model: submission.model.trim(),
    timeoutMs: submission.timeoutMs.trim() || '20000',
    enabled: submission.enabled,
    apiKeyConfigured: submission.clearApiKey ? false : (apiKeyValue !== '' || current.apiKeyConfigured),
  }
}

export interface BridgeToolLibraryItem {
  title: string
  tags: string
}

export interface BridgeToolLibraryFilterState {
  empty: boolean
  statusText: string
  visibleIndexes: number[]
}

export function computeBridgeToolLibraryFilterState (
  items: BridgeToolLibraryItem[],
  keyword: string,
): BridgeToolLibraryFilterState {
  const normalizedKeyword = keyword.trim().toLowerCase()
  const visibleIndexes = items.reduce<number[]>((result, item, index) => {
    const haystack = `${item.title} ${item.tags}`.trim().toLowerCase()
    if (normalizedKeyword === '' || haystack.includes(normalizedKeyword)) {
      result.push(index)
    }
    return result
  }, [])
  return {
    empty: visibleIndexes.length === 0,
    statusText: visibleIndexes.length === 0
      ? '没有匹配的运维入口，请更换关键词后重试。'
      : (normalizedKeyword === ''
          ? `展示 ${visibleIndexes.length} 项运维入口。`
          : `找到 ${visibleIndexes.length} 项与当前关键词相关的运维入口。`),
    visibleIndexes,
  }
}

function renderPage (tokenRequired: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI企微客户运营</title>
  <style>
    :root {
      --bg: #f4eee5;
      --panel: #fbf7f1;
      --card: #fffdf9;
      --text: #1e1b18;
      --muted: #6d6257;
      --muted-strong: #54493f;
      --line: #e0d7cc;
      --accent: #9c4c39;
      --accent-strong: #7d3727;
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
    html, body { height: 100%; }
    body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); overflow: hidden; }
    button, input, select { font: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, .nav-btn:focus-visible, .tab-btn:focus-visible {
      box-shadow: 0 0 0 3px rgba(156, 76, 57, 0.25);
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
    .demo-tag { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; font-size: 12px; color: var(--muted); background: #fff; }
    .page-shell { height: 100vh; padding: var(--space-4); }

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
      grid-template-columns: 280px minmax(0, 1fr);
      gap: var(--space-4);
      height: calc(100vh - var(--space-4) * 2);
      align-items: stretch;
    }
    .sidebar {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: 20px 18px 18px;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      min-height: 0;
      height: 100%;
      position: sticky;
      top: 0;
      overflow: hidden;
    }
    .brand {
      padding: 2px 4px 4px;
      border-bottom: 1px solid rgba(224, 215, 204, 0.8);
    }
    .brand h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.2;
      letter-spacing: 0.02em;
      font-weight: 700;
      color: var(--accent-strong);
    }
    .nav { display: grid; gap: 10px; flex: 1; align-content: start; overflow: auto; min-height: 0; padding-right: 4px; }
    .nav-group { display: grid; gap: 10px; }
    .nav-btn {
      border: 1px solid transparent;
      border-radius: 14px;
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 11px 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
    }
    .nav-btn:hover { background: rgba(255, 255, 255, 0.76); border-color: rgba(224, 215, 204, 0.9); }
    .nav-btn.active { background: #fff; border-color: rgba(156, 76, 57, 0.16); color: var(--accent-strong); font-weight: 600; box-shadow: 0 12px 24px rgba(156, 76, 57, 0.08); }
    .nav-parent { justify-content: space-between; }
    .nav-label { display: inline-flex; align-items: center; gap: 8px; }
    .nav-caret { color: var(--muted); transition: transform 0.2s ease; }
    .nav-parent[aria-expanded="true"] .nav-caret { transform: rotate(180deg); }
    .nav-subnav {
      display: grid;
      gap: 8px;
      padding: 6px 0 0 18px;
      margin: 0;
      list-style: none;
      border-left: 1px solid rgba(156, 76, 57, 0.12);
    }
    .nav-sub-btn {
      padding: 10px 12px 10px 14px;
      color: var(--muted-strong);
      font-size: 14px;
      align-items: flex-start;
      gap: 0;
      position: relative;
    }
    .nav-sub-btn::before {
      content: "";
      position: absolute;
      left: -13px;
      top: 18px;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: rgba(156, 76, 57, 0.18);
    }
    .nav-sub-btn.active::before { background: var(--accent-strong); }
    .nav-sub-copy { display: grid; gap: 3px; }
    .nav-sub-title { font-size: 14px; font-weight: 600; line-height: 1.2; }
    .nav-sub-meta { font-size: 12px; line-height: 1.35; color: var(--muted); }
    .sidebar-foot {
      margin-top: auto;
      border-top: 1px solid var(--line);
      padding-top: 14px;
      position: relative;
      flex: none;
    }
    .account-entry { position: relative; }
    .account-trigger {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      text-align: left;
      color: var(--text);
      min-width: 0;
    }
    .account-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: linear-gradient(135deg, #f3ddd5, #ead0c7);
      color: var(--accent);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      flex: none;
    }
    .account-copy { min-width: 0; display: flex; align-items: center; flex: 1; }
    .account-name {
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .account-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 10px);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow);
      padding: 12px;
      display: grid;
      gap: 10px;
      z-index: 20;
    }
    .menu-actions {
      display: grid;
      gap: 8px;
    }
    .menu-btn { width: 100%; }

    .content {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .content-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--space-4);
      display: grid;
      gap: var(--space-4);
    }
    .content-notice {
      margin: 0;
      border-bottom: 1px solid rgba(224, 215, 204, 0.8);
      padding: 12px var(--space-4);
      color: var(--accent-strong);
      background: rgba(255, 255, 255, 0.7);
      font-size: 14px;
    }

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
    .status-pill { border-radius: 999px; background: #fff; border: 1px solid var(--line); padding: 6px 10px; font-size: 12px; }
    .info-list, .timeline-list, .permission-list, .step-list { display: grid; gap: 10px; padding: 0; margin: 0; list-style: none; }
    .info-list li, .timeline-list li, .permission-list li, .step-list li { display: flex; justify-content: space-between; gap: var(--space-2); align-items: flex-start; }
    .step-list li { justify-content: flex-start; }
    .info-list strong, .timeline-list strong, .permission-list strong { color: var(--text); }

    .bridge-qr { min-height: 220px; display: flex; align-items: center; justify-content: center; background: #fff; border: 1px dashed var(--line); border-radius: var(--radius-sm); margin-top: var(--space-2); }
    .bridge-qr svg { width: min(100%, 280px); height: auto; }

    .tool-btn { width: 100%; margin-top: var(--space-3); }
    .tool-group { display: none; margin-top: 12px; }
    .tool-group.active { display: block; }
    .tool-library-item.hidden { display: none !important; }

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

    .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
    .tab-btn { border: 1px solid var(--line); background: #fff; color: var(--text); border-radius: 999px; padding: 6px 10px; cursor: pointer; }
    .tab-btn.active { border-color: var(--accent); color: var(--accent); }

    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
    .metric-value { margin: 8px 0 0; font-size: 26px; color: var(--text); font-weight: 600; }
    .state-card { display: grid; gap: 8px; }
    .empty-box { border: 1px dashed var(--line); border-radius: var(--radius-sm); padding: var(--space-3); background: #fff; }
    .stat-card {
      background: linear-gradient(180deg, #fffdf9 0%, #fff7f2 100%);
      box-shadow: 0 14px 28px rgba(46, 35, 27, 0.04);
    }
    .metric-caption { margin-top: 10px; font-size: 12px; color: var(--muted); }
    .metric-trend { margin-top: 8px; font-size: 13px; color: var(--accent-strong); }
    .stats-section-grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .mini-bar-list, .funnel-list, .insight-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
    .mini-bar-list li, .funnel-list li, .insight-list li { display: grid; gap: 6px; }
    .mini-bar-meta, .funnel-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--muted-strong); }
    .mini-bar-track, .funnel-track {
      width: 100%;
      height: 10px;
      border-radius: 999px;
      background: rgba(224, 215, 204, 0.72);
      overflow: hidden;
    }
    .mini-bar-fill, .funnel-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #d9846c, #9c4c39);
    }
    .donut-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
    .donut-card { display: grid; justify-items: center; gap: 10px; text-align: center; }
    .donut-ring {
      --ratio: 0deg;
      width: 98px;
      aspect-ratio: 1;
      border-radius: 50%;
      background: conic-gradient(var(--accent) var(--ratio), rgba(238, 216, 209, 0.72) 0deg);
      display: grid;
      place-items: center;
    }
    .donut-ring::after {
      content: "";
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: var(--card);
      box-shadow: inset 0 0 0 1px rgba(224, 215, 204, 0.58);
      grid-area: 1 / 1;
    }
    .donut-ring span {
      grid-area: 1 / 1;
      position: relative;
      z-index: 1;
      font-size: 18px;
      font-weight: 700;
      color: var(--accent-strong);
    }
    .insight-list strong { color: var(--text); }
    .insight-list span { color: var(--muted); }
    .stats-note {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .stats-note p { max-width: 760px; }
    .realtime-grid { display: grid; gap: var(--space-3); grid-template-columns: 1.05fr 1fr; }
    .realtime-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .realtime-list li { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); }
    .realtime-list strong { color: var(--text); }
    .timeline-list.hidden { display: none !important; }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(156, 76, 57, 0.45) rgba(224, 215, 204, 0.5);
    }
    .nav::-webkit-scrollbar, .content-scroll::-webkit-scrollbar, .account-menu::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    .nav::-webkit-scrollbar-track, .content-scroll::-webkit-scrollbar-track, .account-menu::-webkit-scrollbar-track {
      background: rgba(224, 215, 204, 0.5);
      border-radius: 999px;
    }
    .nav::-webkit-scrollbar-thumb, .content-scroll::-webkit-scrollbar-thumb, .account-menu::-webkit-scrollbar-thumb {
      background: rgba(156, 76, 57, 0.42);
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .nav::-webkit-scrollbar-thumb:hover, .content-scroll::-webkit-scrollbar-thumb:hover, .account-menu::-webkit-scrollbar-thumb:hover {
      background: rgba(156, 76, 57, 0.62);
      background-clip: padding-box;
    }

    @media (max-width: 1024px) {
      .grid.three, .metric-grid, .donut-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stats-section-grid, .realtime-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 860px) {
      body { overflow: auto; }
      .page-shell { padding: var(--space-2); }
      .app { grid-template-columns: 1fr; height: auto; min-height: calc(100vh - var(--space-2) * 2); }
      .sidebar { gap: var(--space-3); position: static; height: auto; }
      .nav { grid-template-columns: 1fr; overflow: visible; }
      .nav-btn { font-size: 13px; padding: 9px 11px; }
      .nav-subnav { padding-left: 12px; }
      .nav-sub-btn { padding-left: 12px; }
      .grid.two, .grid.three, .metric-grid, .donut-grid { grid-template-columns: 1fr; }
      .content { min-height: 0; }
      .content-scroll { overflow: visible; }
      .account-menu { position: static; margin-top: 8px; }
    }
  </style>
</head>
<body>
  <main class="page-shell">
    <section id="login-screen" class="login-wrap">
      <article class="login-card">
        <span class="demo-tag">平台登录</span>
        <h1 class="login-title">AI企微客户运营</h1>
        <p class="muted">当前控制台通过平台访问令牌建立会话。用户名固定为 <strong>admin</strong>，密码校验沿用后端会话认证流程（BRIDGE_WEB_TOKEN），页面不会展示或回显任何真实密钥。</p>
        <form id="login-form" class="login-form">
          <div class="field">
            <label for="login-username">用户名</label>
            <input id="login-username" class="input" type="text" value="admin" readonly required>
          </div>
          <div class="field">
            <label for="login-password">访问令牌</label>
            <input id="login-password" class="input" type="password" autocomplete="current-password" required>
          </div>
          <button id="login-submit" class="btn" type="submit">登录控制台</button>
        </form>
        <p id="login-error" class="error hidden"></p>
      </article>
    </section>

    <section id="app-screen" class="app hidden" aria-live="polite">
      <aside class="sidebar">
        <header class="brand">
          <h1>AI企微客户运营中台</h1>
        </header>
        <nav class="nav" aria-label="工作台导航">
          <button class="nav-btn active" data-nav="account" type="button">🔗 账号链接</button>
          <button class="nav-btn" data-nav="tools" type="button">🧰 工具</button>
          <button class="nav-btn" data-nav="rag" type="button">📚 AI 知识库（RAG）</button>
          <button class="nav-btn" data-nav="stats" type="button">📊 数据统计</button>
          <div class="nav-group">
            <button id="settings-nav-toggle" class="nav-btn nav-parent" type="button" aria-expanded="false" aria-controls="settings-nav-panel">
              <span class="nav-label">⚙️ 设置</span>
              <span class="nav-caret" aria-hidden="true">▾</span>
            </button>
            <ul id="settings-nav-panel" class="nav-subnav hidden" aria-label="设置子导航">
              <li><button class="nav-btn nav-sub-btn" data-nav="model-config" type="button"><span class="nav-sub-copy"><span class="nav-sub-title">模型配置</span><span class="nav-sub-meta">模型接入、启用状态与密钥管理</span></span></button></li>
              <li><button class="nav-btn nav-sub-btn" data-nav="people" type="button"><span class="nav-sub-copy"><span class="nav-sub-title">人员管理</span><span class="nav-sub-meta">查看成员角色、状态与协作分工</span></span></button></li>
              <li><button class="nav-btn nav-sub-btn" data-nav="teams" type="button"><span class="nav-sub-copy"><span class="nav-sub-title">团队管理</span><span class="nav-sub-meta">组织分组、负责人和服务范围配置</span></span></button></li>
              <li><button class="nav-btn nav-sub-btn" data-nav="permissions" type="button"><span class="nav-sub-copy"><span class="nav-sub-title">权限管理</span><span class="nav-sub-meta">角色授权、策略说明与访问控制</span></span></button></li>
            </ul>
          </div>
        </nav>
        <footer class="sidebar-foot">
          <div class="account-entry">
            <button id="account-menu-trigger" class="account-trigger" type="button" aria-expanded="false" aria-controls="account-menu-panel">
              <span class="account-avatar" aria-hidden="true">A</span>
              <span class="account-copy">
                <span class="account-name">admin</span>
              </span>
              <span class="nav-caret" aria-hidden="true">▾</span>
            </button>
            <div id="account-menu-panel" class="account-menu hidden" aria-label="账户菜单">
              <div class="menu-actions">
                <button id="logout-btn" type="button" class="btn btn-secondary menu-btn">退出登录</button>
              </div>
            </div>
          </div>
        </footer>
      </aside>

      <section class="content">
        <div class="sr-only">
          <h2 id="page-title">账号链接</h2>
          <p class="muted" id="page-subtitle">统一管理企业微信账号绑定、扫码登录与验证码校验。</p>
        </div>
        <p id="content-notice" class="content-notice hidden" role="status" aria-live="polite"></p>
        <div class="content-scroll">
          <section id="page-account" class="page active" tabindex="-1">
            <div class="grid two">
              <article class="card">
                <div class="section-head">
                  <h3>账号绑定</h3>
                  <span id="account-link-status" class="status-pill">待连接</span>
                </div>
                <p class="muted">该入口用于绑定企业微信服务账号与 Bridge 连接状态，不再展示历史创作预览体验。</p>
                <ul class="info-list" style="margin-top: 12px;">
                  <li><strong>当前绑定账号</strong><span id="account-bound-user">未绑定</span></li>
                  <li><strong>最近同步</strong><span id="account-last-updated">-</span></li>
                  <li><strong>下一步操作</strong><span id="account-next-step">等待控制台完成初始化。</span></li>
                </ul>
                <ol class="step-list muted" style="margin-top: 16px;">
                  <li>1. 进入扫码状态后，使用测试员工账号在企业微信中扫码。</li>
                  <li>2. 如手机端提示验证码，请在右侧实时状态卡中输入并提交。</li>
                  <li>3. Bridge 就绪后，账号绑定状态会自动切换为“已连接”。</li>
                </ol>
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
                  <form id="verify-form" class="grid" style="margin-top: 12px;">
                    <input id="verify-code" class="input" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="输入验证码" required>
                    <button id="verify-submit" class="btn" type="submit">提交验证码</button>
                  </form>
                  <p id="verify-feedback" class="hidden"></p>
                </div>
              </article>
            </div>
          </section>

          <section id="page-tools" class="page" tabindex="-1">
            <article class="card">
              <div class="section-head">
                <h3>工具中心</h3>
                <span class="status-pill">按能力分组访问</span>
              </div>
              <p class="muted">运维工具已整合节日问候、产品介绍、FAQ 等扩展能力，可继续通过分组、搜索和兼容入口快速访问。</p>

              <section id="tool-group-operations" class="tool-group active">
                <div class="card">
                  <div class="section-head">
                    <h3>运维工具</h3>
                    <span class="status-pill">核心运营动作</span>
                  </div>
                  <div class="grid three">
                    <article class="card"><h3>👋 欢迎语</h3><p>根据客户标签生成开场话术。</p><button class="btn btn-secondary tool-btn" data-tool="欢迎语" type="button">查看能力</button></article>
                    <article class="card"><h3>⏰ 定时推送</h3><p>设置节奏化客户触达任务。</p><button class="btn btn-secondary tool-btn" data-tool="定时推送" type="button">查看能力</button></article>
                    <article class="card"><h3>⚡ 快捷回复</h3><p>常见场景一键引用回复。</p><button class="btn btn-secondary tool-btn" data-tool="快捷回复" type="button">查看能力</button></article>
                    <article class="card"><h3>🧾 会话记录</h3><p>按客户查看沟通摘要与跟进重点。</p><button class="btn btn-secondary tool-btn" data-tool="会话记录" type="button">查看能力</button></article>
                    <article class="card"><h3>🧠 AI 客户画像分析</h3><p>识别客户意向、偏好和生命周期。</p><button class="btn btn-secondary tool-btn" data-tool="AI 客户画像分析" type="button">查看能力</button></article>
                    <article class="card"><h3>📈 AI 老客维护策略推荐</h3><p>提供复购、关怀和沉睡唤醒建议。</p><button class="btn btn-secondary tool-btn" data-tool="AI 老客维护策略推荐" type="button">查看能力</button></article>
                  </div>
                  <div id="tool-library-section" class="card" style="margin-top: 16px;">
                    <div class="section-head">
                      <h3>运维扩展入口</h3>
                      <span class="status-pill">兼容旧路径</span>
                    </div>
                    <p class="muted">节日问候、产品介绍、FAQ 已归入运维工具子功能，保留原有能力入口与搜索方式。</p>
                    <input id="tool-library-search" class="input" type="search" placeholder="搜索运维入口，如：节日 / FAQ">
                    <p id="tool-library-status" class="muted" role="status" aria-live="polite" style="margin-top: 12px;">展示 4 项运维入口。</p>
                    <div id="tool-library-list" class="grid two" style="margin-top: 12px;">
                      <article class="card tool-library-item" data-title="欢迎语模板" data-tags="欢迎 新客 开场">
                        <h3>欢迎语模板</h3>
                        <p>用于首次触达新客户的标准开场。</p>
                        <div class="tags"><span class="tag">欢迎</span><span class="tag">新客</span></div>
                        <button class="btn btn-secondary tool-btn" data-tool="欢迎语模板" type="button">查看能力</button>
                      </article>
                      <article class="card tool-library-item" data-title="节日问候" data-tags="节日 关怀 活动">
                        <h3>节日问候</h3>
                        <p>用于节日关怀、活动通知和老客唤醒场景。</p>
                        <div class="tags"><span class="tag">节日</span><span class="tag">关怀</span></div>
                        <button class="btn btn-secondary tool-btn" data-tool="节日问候" type="button">查看能力</button>
                      </article>
                      <article class="card tool-library-item" data-title="产品介绍" data-tags="产品 卖点 话术">
                        <h3>产品介绍</h3>
                        <p>集中展示核心卖点、资料摘要与标准讲解话术。</p>
                        <div class="tags"><span class="tag">产品</span><span class="tag">卖点</span></div>
                        <button class="btn btn-secondary tool-btn" data-tool="产品介绍" type="button">查看能力</button>
                      </article>
                      <article class="card tool-library-item" data-title="FAQ" data-tags="FAQ 问答 客服">
                        <h3>FAQ</h3>
                        <p>归档高频问题与统一答复口径，便于客服快速调用。</p>
                        <div class="tags"><span class="tag">FAQ</span><span class="tag">客服</span></div>
                        <button class="btn btn-secondary tool-btn" data-tool="FAQ" type="button">查看能力</button>
                      </article>
                    </div>
                    <div id="tool-library-empty" class="empty-box hidden" style="margin-top: 12px;">没有匹配的运维入口，请更换关键词后重试。</div>
                  </div>
                </div>
              </section>
            </article>
          </section>

          <section id="page-rag" class="page" tabindex="-1">
            <article class="card">
              <div class="section-head">
                <h3>AI 知识库（RAG）</h3>
                <span class="status-pill">待接入在线检索结果</span>
              </div>
              <form id="rag-form" class="grid" style="margin: 0 0 12px;">
                <input id="rag-query" class="input" type="text" placeholder="输入检索关键词，例如：退换货政策">
                <button id="rag-search" class="btn" type="submit">检索</button>
              </form>
              <div class="tabs" style="margin-bottom: 10px;">
                <span class="status-pill">命中率：待接入</span>
                <span class="status-pill">覆盖率：待接入</span>
                <button id="rag-add" class="btn btn-secondary" type="button">添加文档</button>
              </div>
              <div class="grid two">
                <article class="card"><h3>售后服务手册</h3><p>标签：售后 / 退款 / 物流</p></article>
                <article class="card"><h3>新品发布培训稿</h3><p>标签：产品 / 卖点 / 异议处理</p></article>
                <article class="card"><h3>会员运营 SOP</h3><p>标签：老客 / 复购 / 关怀</p></article>
                <article class="card"><h3>品牌语调规范</h3><p>标签：品牌 / 文案 / 口吻</p></article>
              </div>
              <p id="rag-feedback" class="muted" style="margin-top: 12px;">当前控制台仅提供结构化入口，检索结果与指标待后端接口接入。</p>
            </article>
          </section>

          <section id="page-stats" class="page" tabindex="-1">
            <article class="card">
              <div class="section-head">
                <h3>数据统计</h3>
                <span id="stats-sync-state" class="status-pill">同步中</span>
              </div>
              <div class="stats-note">
                <p class="muted">以下运营指标为界面展示数据，用于呈现渠道、会话、客户、消息与转化视图；连接状态、扫码与验证码相关信息仍以下方实时同步结果为准。</p>
                <span class="status-pill">界面展示数据</span>
              </div>
              <div id="stats-loading" class="card state-card" style="margin-top: 12px;">
                <h3>统计加载中</h3>
                <p>正在获取 Bridge 实时状态与最近事件。</p>
              </div>
              <div id="stats-error" class="card state-card hidden" style="margin-top: 12px;">
                <h3>统计加载失败</h3>
                <p id="stats-error-text">请稍后重试。</p>
              </div>
              <div id="stats-content" class="grid hidden" style="margin-top: 12px;">
                <div class="metric-grid">
                  <article class="card stat-card"><h3>今日会话总量</h3><p class="metric-value">382</p><p class="metric-caption">多渠道接待与营销跟进合计</p><p class="metric-trend">较近 7 日均值 +12.4%</p></article>
                  <article class="card stat-card"><h3>新增客户</h3><p class="metric-value">46</p><p class="metric-caption">来自私域沉淀、活动扫码与转介绍</p><p class="metric-trend">私域渠道贡献 61%</p></article>
                  <article class="card stat-card"><h3>AI 回复占比</h3><p class="metric-value">78%</p><p class="metric-caption">高频问答自动接待覆盖率</p><p class="metric-trend">FAQ 与快捷回复稳定提升</p></article>
                  <article class="card stat-card"><h3>人工接管率</h3><p class="metric-value">14%</p><p class="metric-caption">复杂咨询与重点客户人工承接</p><p class="metric-trend">高意向客户优先转人工</p></article>
                  <article class="card stat-card"><h3>线索转化</h3><p class="metric-value">23</p><p class="metric-caption">进入重点跟进池的客户线索数</p><p class="metric-trend">转化效率环比 +8.1%</p></article>
                  <article class="card stat-card"><h3>客户满意度</h3><p class="metric-value">96%</p><p class="metric-caption">基于话术规范、响应时效与回访结果</p><p class="metric-trend">老客维护表现稳定</p></article>
                </div>
                <div class="stats-section-grid">
                  <article class="card">
                    <div class="section-head">
                      <h3>渠道来源分布</h3>
                      <span class="status-pill">近 7 日</span>
                    </div>
                    <ul class="mini-bar-list">
                      <li><div class="mini-bar-meta"><strong>企业微信私域</strong><span>68%</span></div><div class="mini-bar-track"><span class="mini-bar-fill" style="width:68%"></span></div></li>
                      <li><div class="mini-bar-meta"><strong>活动拉新</strong><span>17%</span></div><div class="mini-bar-track"><span class="mini-bar-fill" style="width:17%"></span></div></li>
                      <li><div class="mini-bar-meta"><strong>老客复购</strong><span>9%</span></div><div class="mini-bar-track"><span class="mini-bar-fill" style="width:9%"></span></div></li>
                      <li><div class="mini-bar-meta"><strong>转介绍</strong><span>6%</span></div><div class="mini-bar-track"><span class="mini-bar-fill" style="width:6%"></span></div></li>
                    </ul>
                  </article>
                  <article class="card">
                    <div class="section-head">
                      <h3>客户结构占比</h3>
                      <span class="status-pill">当前展示</span>
                    </div>
                    <div class="donut-grid">
                      <div class="donut-card"><div class="donut-ring" style="--ratio:252deg"><span>70%</span></div><div><strong>新客激活</strong><p>首次触达后 24 小时内保持响应</p></div></div>
                      <div class="donut-card"><div class="donut-ring" style="--ratio:144deg"><span>40%</span></div><div><strong>重点跟进</strong><p>进入高意向池并持续追踪</p></div></div>
                      <div class="donut-card"><div class="donut-ring" style="--ratio:94deg"><span>26%</span></div><div><strong>老客复购</strong><p>维护周期内再次成交占比</p></div></div>
                    </div>
                  </article>
                </div>
                <div class="realtime-grid">
                  <article class="card">
                    <div class="section-head">
                      <h3>实时连接概览</h3>
                      <span class="status-pill">Bridge 同步</span>
                    </div>
                    <ul class="realtime-list">
                      <li><strong>当前状态</strong><span id="stats-current-phase">-</span></li>
                      <li><strong>状态事件数</strong><span id="stats-event-count">0</span></li>
                      <li><strong>验证码请求</strong><span id="stats-verify-count">0</span></li>
                      <li><strong>扫码请求</strong><span id="stats-scan-count">0</span></li>
                      <li><strong>绑定账号</strong><span id="stats-account-user">未绑定</span></li>
                      <li><strong>最近同步</strong><span id="stats-last-updated">-</span></li>
                    </ul>
                    <div id="stats-timeline-empty" class="empty-box" style="margin-top: 14px;">暂无状态事件，等待 Bridge 推送或手动刷新。</div>
                    <ul id="stats-timeline" class="timeline-list hidden" style="margin-top: 14px;"></ul>
                  </article>
                  <article class="card">
                    <div class="section-head">
                      <h3>转化漏斗</h3>
                      <span class="status-pill">运营重点</span>
                    </div>
                    <ul class="funnel-list">
                      <li><div class="funnel-meta"><strong>触达客户</strong><span>1,280</span></div><div class="funnel-track"><span class="funnel-fill" style="width:100%"></span></div></li>
                      <li><div class="funnel-meta"><strong>有效对话</strong><span>864</span></div><div class="funnel-track"><span class="funnel-fill" style="width:67%"></span></div></li>
                      <li><div class="funnel-meta"><strong>高意向线索</strong><span>219</span></div><div class="funnel-track"><span class="funnel-fill" style="width:38%"></span></div></li>
                      <li><div class="funnel-meta"><strong>跟进预约</strong><span>74</span></div><div class="funnel-track"><span class="funnel-fill" style="width:22%"></span></div></li>
                      <li><div class="funnel-meta"><strong>成交转化</strong><span>23</span></div><div class="funnel-track"><span class="funnel-fill" style="width:11%"></span></div></li>
                    </ul>
                  </article>
                </div>
                <div class="stats-section-grid">
                  <article class="card">
                    <div class="section-head">
                      <h3>消息质量观察</h3>
                      <span class="status-pill">会话维度</span>
                    </div>
                    <ul class="insight-list">
                      <li><strong>平均首响时长</strong><span>22 秒，热点活动时段保持在 30 秒内</span></li>
                      <li><strong>高频咨询主题</strong><span>产品报价、活动权益、交付周期、售后流程</span></li>
                      <li><strong>快捷回复采用率</strong><span>63%，高峰时段显著降低人工输入负担</span></li>
                    </ul>
                  </article>
                  <article class="card">
                    <div class="section-head">
                      <h3>运营建议看板</h3>
                      <span class="status-pill">建议动作</span>
                    </div>
                    <ul class="insight-list">
                      <li><strong>渠道优化</strong><span>继续提升活动拉新后的 2 小时首触达覆盖，避免线索降温。</span></li>
                      <li><strong>客户分层</strong><span>将连续 3 次互动的客户自动推送给重点跟进团队，缩短成单周期。</span></li>
                      <li><strong>内容补齐</strong><span>优先补充 FAQ 和产品介绍中关于价格异议处理的话术模板。</span></li>
                    </ul>
                  </article>
                </div>
              </div>
            </article>
          </section>

          <section id="page-model-config" class="page" tabindex="-1">
            <div class="grid two">
              <article class="card">
                <div class="section-head">
                  <h3>模型配置</h3>
                  <span class="status-pill">敏感密钥默认脱敏</span>
                </div>
                <p class="muted">当前控制台尚未暴露持久化模型配置 API。以下表单用于对齐后续接入结构，保存后仅保留当前页面内存状态，API Key 不会回显或写入日志。</p>
                <ul class="info-list" style="margin-top: 12px;">
                  <li><strong>配置来源</strong><span>前端临时状态 / 待接入后端</span></li>
                  <li><strong>API Key 状态</strong><span id="model-api-key-status">未配置</span></li>
                  <li><strong>启用状态</strong><span id="model-enabled-status">未启用</span></li>
                </ul>
              </article>
              <article class="card">
                <form id="model-config-form" class="grid">
                  <div class="field">
                    <label for="model-provider">提供商</label>
                    <select id="model-provider" class="input">
                      <option value="openai-compatible">OpenAI 兼容</option>
                      <option value="azure-openai">Azure OpenAI</option>
                      <option value="custom">自定义</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="model-base-url">Base URL</label>
                    <input id="model-base-url" class="input" type="url" placeholder="https://api.example.com/v1">
                  </div>
                  <div class="field">
                    <label for="model-name">模型</label>
                    <input id="model-name" class="input" type="text" placeholder="gpt-4o-mini / deepseek-chat">
                  </div>
                  <div class="field">
                    <label for="model-timeout">超时（毫秒）</label>
                    <input id="model-timeout" class="input" type="number" min="1000" step="1000" value="20000">
                  </div>
                  <div class="field">
                    <label for="model-api-key">API Key（重新输入才会更新）</label>
                    <input id="model-api-key" class="input" type="password" autocomplete="new-password" placeholder="已配置时不会回显真实值">
                  </div>
                  <label style="display:flex;align-items:center;gap:8px;"><input id="model-clear-api-key" type="checkbox">清除已保存的 API Key 状态</label>
                  <label style="display:flex;align-items:center;gap:8px;"><input id="model-enabled" type="checkbox">启用当前模型配置</label>
                  <div class="tabs">
                    <button id="model-config-save" class="btn" type="submit" data-permission="manageModels">保存配置</button>
                    <button id="model-config-reset" class="btn btn-secondary" type="button">恢复表单</button>
                  </div>
                  <p id="model-config-feedback" class="muted">尚未保存临时配置。</p>
                </form>
              </article>
            </div>
          </section>

          <section id="page-people" class="page" tabindex="-1">
            <div class="grid two">
              <article class="card">
                <div class="section-head">
                  <h3>人员管理</h3>
                  <span class="status-pill">待接入用户 API</span>
                </div>
                <p class="muted">优先保留人员目录、状态与角色的页面结构；当前仓库尚未提供可安全复用的人员管理写入接口，因此本页仅展示信息架构和空状态。</p>
                <div class="empty-box" style="margin-top: 12px;">暂无可展示的人员列表。待后端提供用户/组织查询接口后展示真实数据。</div>
              </article>
              <article class="card">
                <h3>计划中的能力</h3>
                <ul class="permission-list" style="margin-top: 12px;">
                  <li><strong>人员目录</strong><span>查询 / 搜索 / 状态筛选</span></li>
                  <li><strong>角色分配</strong><span>按权限控制编辑入口</span></li>
                  <li><strong>账号停用</strong><span>待接入真实管理接口</span></li>
                </ul>
                <button class="btn btn-secondary tool-btn" type="button" data-permission="managePeople">创建人员（待接入）</button>
              </article>
            </div>
          </section>

          <section id="page-teams" class="page" tabindex="-1">
            <div class="grid two">
              <article class="card">
                <div class="section-head">
                  <h3>团队管理</h3>
                  <span class="status-pill">待接入组织 API</span>
                </div>
                <p class="muted">当前页面预留团队列表、负责人、覆盖账号和协作范围等结构，待复用后端组织能力后接入真实数据。</p>
                <div class="empty-box" style="margin-top: 12px;">暂无团队数据。后端组织架构接口接入前不会伪造写入结果。</div>
              </article>
              <article class="card">
                <h3>推荐信息架构</h3>
                <ul class="permission-list" style="margin-top: 12px;">
                  <li><strong>团队负责人</strong><span>支持绑定内部账号</span></li>
                  <li><strong>服务范围</strong><span>按客户池 / 标签 / 渠道配置</span></li>
                  <li><strong>协作状态</strong><span>待接入排班与可用性能力</span></li>
                </ul>
                <button class="btn btn-secondary tool-btn" type="button" data-permission="manageTeams">新建团队（待接入）</button>
              </article>
            </div>
          </section>

          <section id="page-permissions" class="page" tabindex="-1">
            <div class="grid two">
              <article class="card">
                <div class="section-head">
                  <h3>权限管理</h3>
                  <span class="status-pill">按当前登录权限控制</span>
                </div>
                <ul class="permission-list">
                  <li><strong>模型配置</strong><span id="perm-models">可管理</span></li>
                  <li><strong>人员管理</strong><span id="perm-people">可管理</span></li>
                  <li><strong>团队管理</strong><span id="perm-teams">可管理</span></li>
                  <li><strong>权限策略</strong><span id="perm-permissions">可管理</span></li>
                </ul>
                <p class="muted" style="margin-top: 12px;">如当前用户没有对应权限，相关操作按钮会被禁用或隐藏，避免所有用户都看到管理员操作。</p>
              </article>
              <article class="card">
                <h3>策略操作</h3>
                <div class="grid" style="margin-top: 12px;">
                  <button class="btn btn-secondary" type="button" data-permission="managePermissions">新增权限策略（待接入）</button>
                  <button class="btn btn-secondary" type="button" data-permission="managePermissions">分配角色（待接入）</button>
                  <button class="btn btn-secondary" type="button">查看权限说明</button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>
    </section>
  </main>

  <div id="tool-modal-mask" class="modal-mask hidden" role="dialog" aria-modal="true" aria-labelledby="tool-modal-title">
    <article class="modal">
      <h3 id="tool-modal-title">工具详情</h3>
      <p id="tool-modal-content" class="muted"></p>
      <p class="muted">功能入口已产品化，详细业务能力将随对应后端接口逐步接入。</p>
      <button id="tool-modal-close" type="button" class="btn btn-secondary">关闭</button>
    </article>
  </div>

  <script>
    const productName = 'AI企微客户运营'
    const bootstrap = { tokenRequired: ${tokenRequired ? 'true' : 'false'} }
    const pageAliases = ${JSON.stringify(BRIDGE_CONSOLE_ROUTE_ALIASES)}
    const computeNextModelConfigState = ${computeBridgeModelConfigState.toString()}
    const computeToolLibraryFilterState = ${computeBridgeToolLibraryFilterState.toString()}
    const permissionDescriptors = [
      { key: 'manageModels', labelId: 'perm-models' },
      { key: 'managePeople', labelId: 'perm-people' },
      { key: 'manageTeams', labelId: 'perm-teams' },
      { key: 'managePermissions', labelId: 'perm-permissions' },
    ]
    const currentUser = {
      username: 'admin',
      permissions: {
        manageModels: true,
        managePeople: true,
        manageTeams: true,
        managePermissions: true,
      },
    }
    const modelConfigState = {
      provider: 'openai-compatible',
      baseUrl: '',
      model: '',
      timeoutMs: '20000',
      enabled: false,
      apiKeyConfigured: false,
    }
    const statsState = {
      initialized: false,
      history: [],
      lastSignature: '',
    }
    let csrfToken = null
    let eventSource = null
    let latestRequestId = null
    let manualLoggedOut = false
    let selectedPage = 'account'
    let activeToolGroup = 'operations'
    let lastToolTrigger = null
    let reconnectTimer = null
    let settingsExpanded = false

    const pageMeta = {
      account: { title: '账号链接', subtitle: '统一管理企业微信账号绑定、扫码登录与验证码校验。' },
      tools: { title: '工具', subtitle: '运维工具已整合节日问候、产品介绍、FAQ 等扩展能力。' },
      rag: { title: 'AI 知识库（RAG）', subtitle: '保留知识库入口，检索结果与指标待后端接口接入。' },
      stats: { title: '数据统计', subtitle: '展示渠道、会话、客户、消息与转化视图，并保留 Bridge 实时状态同步。' },
      'model-config': { title: '模型配置', subtitle: '支持编辑当前页临时配置，敏感密钥默认脱敏。' },
      people: { title: '人员管理', subtitle: '预留用户管理信息架构，待接入真实用户 API。' },
      teams: { title: '团队管理', subtitle: '预留团队协作结构，待接入真实组织 API。' },
      permissions: { title: '权限管理', subtitle: '按当前用户权限显示或禁用管理员操作。' },
    }

    const toolDescriptions = {
      '欢迎语': '根据客户来源与标签生成暖场欢迎语模板。',
      '定时推送': '配置触达节奏、发送时段与内容包。',
      '快捷回复': '沉淀高频问答，支持一键插入会话。',
      '会话记录': '展示客户会话摘要和重点跟进建议。',
      'AI 客户画像分析': '基于互动行为生成客户偏好与意向等级。',
      'AI 老客维护策略推荐': '针对老客户生命周期给出分层维护策略。',
      '欢迎语模板': '保留原有模板入口，用于首次触达新客户的标准开场。',
      '节日问候': '覆盖常见节日关怀与活动通知场景的话术模板。',
      '产品介绍': '集中展示核心卖点、产品资料与常见讲解话术。',
      FAQ: '沉淀高频问题与统一答复口径，便于客服快速引用。',
    }

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
      contentNotice: document.getElementById('content-notice'),
      contentScroll: document.querySelector('.content-scroll'),
      settingsNavToggle: document.getElementById('settings-nav-toggle'),
      settingsNavPanel: document.getElementById('settings-nav-panel'),
      navButtons: Array.from(document.querySelectorAll('.nav-btn')),
      settingsNavItems: Array.from(document.querySelectorAll('.nav-sub-btn')),
      pages: Array.from(document.querySelectorAll('.page')),
      logoutBtn: document.getElementById('logout-btn'),
      accountMenuTrigger: document.getElementById('account-menu-trigger'),
      accountMenuPanel: document.getElementById('account-menu-panel'),
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
      accountLinkStatus: document.getElementById('account-link-status'),
      accountBoundUser: document.getElementById('account-bound-user'),
      accountLastUpdated: document.getElementById('account-last-updated'),
      accountNextStep: document.getElementById('account-next-step'),
      toolLibrarySearch: document.getElementById('tool-library-search'),
      toolLibraryStatus: document.getElementById('tool-library-status'),
      toolLibraryEmpty: document.getElementById('tool-library-empty'),
      toolLibraryItems: Array.from(document.querySelectorAll('.tool-library-item')),
      toolButtons: Array.from(document.querySelectorAll('.tool-btn[data-tool]')),
      toolGroupButtons: Array.from(document.querySelectorAll('[data-tool-group]')),
      toolGroups: Array.from(document.querySelectorAll('.tool-group')),
      toolModalMask: document.getElementById('tool-modal-mask'),
      toolModalTitle: document.getElementById('tool-modal-title'),
      toolModalContent: document.getElementById('tool-modal-content'),
      toolModalClose: document.getElementById('tool-modal-close'),
      ragQuery: document.getElementById('rag-query'),
      ragForm: document.getElementById('rag-form'),
      ragAdd: document.getElementById('rag-add'),
      ragFeedback: document.getElementById('rag-feedback'),
      statsSyncState: document.getElementById('stats-sync-state'),
      statsLoading: document.getElementById('stats-loading'),
      statsError: document.getElementById('stats-error'),
      statsErrorText: document.getElementById('stats-error-text'),
      statsContent: document.getElementById('stats-content'),
      statsCurrentPhase: document.getElementById('stats-current-phase'),
      statsEventCount: document.getElementById('stats-event-count'),
      statsVerifyCount: document.getElementById('stats-verify-count'),
      statsScanCount: document.getElementById('stats-scan-count'),
      statsAccountUser: document.getElementById('stats-account-user'),
      statsLastUpdated: document.getElementById('stats-last-updated'),
      statsTimeline: document.getElementById('stats-timeline'),
      statsTimelineEmpty: document.getElementById('stats-timeline-empty'),
      modelConfigForm: document.getElementById('model-config-form'),
      modelProvider: document.getElementById('model-provider'),
      modelBaseUrl: document.getElementById('model-base-url'),
      modelName: document.getElementById('model-name'),
      modelTimeout: document.getElementById('model-timeout'),
      modelApiKey: document.getElementById('model-api-key'),
      modelClearApiKey: document.getElementById('model-clear-api-key'),
      modelEnabled: document.getElementById('model-enabled'),
      modelConfigReset: document.getElementById('model-config-reset'),
      modelConfigFeedback: document.getElementById('model-config-feedback'),
      modelApiKeyStatus: document.getElementById('model-api-key-status'),
      modelEnabledStatus: document.getElementById('model-enabled-status'),
      permissionNodes: Array.from(document.querySelectorAll('[data-permission]')),
    }

    document.title = productName

    function setHidden (element, hidden) {
      if (!element) return
      element.classList.toggle('hidden', hidden)
    }

    function setText (element, value) {
      if (!element) return
      element.textContent = value
    }

    function setContentNotice (message) {
      if (!message) {
        setText(elements.contentNotice, '')
        setHidden(elements.contentNotice, true)
        return
      }
      setText(elements.contentNotice, message)
      setHidden(elements.contentNotice, false)
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

    function setAccountMenuOpen (open) {
      setHidden(elements.accountMenuPanel, !open)
      elements.accountMenuTrigger.setAttribute('aria-expanded', open ? 'true' : 'false')
    }

    function focusAccountMenuAction () {
      elements.logoutBtn.focus()
    }

    function openAccountMenu (focusAction = false) {
      setAccountMenuOpen(true)
      if (focusAction) {
        focusAccountMenuAction()
      }
    }

    function isSettingsPage (pageKey) {
      return ['model-config', 'people', 'teams', 'permissions'].includes(pageKey)
    }

    function syncSettingsNavigation () {
      const expanded = settingsExpanded
      elements.settingsNavToggle.classList.toggle('active', isSettingsPage(selectedPage) || expanded)
      elements.settingsNavToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      setHidden(elements.settingsNavPanel, !expanded)
      elements.settingsNavItems.forEach((button) => {
        button.classList.toggle('active', button.dataset.nav === selectedPage)
      })
    }

    function normalizeRoute (raw) {
      const clean = String(raw || '').trim().replace(/^#+/, '').toLowerCase()
      return pageAliases[clean] || 'account'
    }

    function deriveRouteState () {
      const hashValue = window.location.hash.replace(/^#/, '').trim().toLowerCase()
      const queryValue = new URLSearchParams(window.location.search).get('page') || ''
      const raw = hashValue || queryValue || 'account'
      return {
        page: normalizeRoute(raw),
        toolGroup: 'operations',
        scrollToAssets: raw === 'assets' || raw === 'content-assets',
      }
    }

    function setActiveToolGroup (groupKey) {
      activeToolGroup = 'operations'
      elements.toolGroupButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.toolGroup === activeToolGroup)
      })
      elements.toolGroups.forEach((group) => {
        group.classList.toggle('active', group.id === 'tool-group-' + activeToolGroup)
      })
    }

    function syncLocationHash () {
      window.location.hash = selectedPage
    }

    function setActivePage (pageKey, options) {
      const settings = options || {}
      selectedPage = normalizeRoute(pageKey)
      if (isSettingsPage(selectedPage)) {
        settingsExpanded = true
      }
      const meta = pageMeta[selectedPage] || pageMeta.account
      setText(elements.pageTitle, meta.title)
      setText(elements.pageSubtitle, meta.subtitle)
      elements.navButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.nav === selectedPage)
      })
      elements.pages.forEach((page) => {
        page.classList.toggle('active', page.id === 'page-' + selectedPage)
      })
      syncSettingsNavigation()
      setAccountMenuOpen(false)
      if (settings.updateHash !== false) {
        syncLocationHash()
      }
      document.title = productName
      if (settings.focus !== false) {
        const activePage = elements.pages.find((page) => page.id === 'page-' + selectedPage)
        if (activePage && typeof activePage.focus === 'function') {
          activePage.focus()
        }
      }
      if (elements.contentScroll) {
        elements.contentScroll.scrollTop = 0
      }
    }

    function hasPermission (permissionKey) {
      return Boolean(currentUser.permissions[permissionKey] ?? false)
    }

    function applyPermissionGuards () {
      elements.permissionNodes.forEach((node) => {
        const permissionKey = node.getAttribute('data-permission')
        const allowed = hasPermission(permissionKey)
        if ('disabled' in node) {
          node.disabled = !allowed
        }
        node.setAttribute('aria-disabled', allowed ? 'false' : 'true')
      })
      permissionDescriptors.forEach((descriptor) => {
        const label = document.getElementById(descriptor.labelId)
        setText(label, hasPermission(descriptor.key) ? '可管理' : '只读')
      })
    }

    function renderModelConfigState (feedback) {
      elements.modelProvider.value = modelConfigState.provider
      elements.modelBaseUrl.value = modelConfigState.baseUrl
      elements.modelName.value = modelConfigState.model
      elements.modelTimeout.value = modelConfigState.timeoutMs
      elements.modelClearApiKey.checked = false
      elements.modelEnabled.checked = modelConfigState.enabled
      setText(elements.modelApiKeyStatus, modelConfigState.apiKeyConfigured ? '已配置（仅当前页面内存）' : '未配置')
      setText(elements.modelEnabledStatus, modelConfigState.enabled ? '已启用' : '未启用')
      if (feedback) {
        setText(elements.modelConfigFeedback, feedback)
      }
    }

    function getAccountNextStep (status) {
      if (status.phase === 'ready') return 'Bridge 已就绪，可开始处理消息。'
      if (status.phase === 'logged-in') return '账号已登录，等待 Bridge 完成初始化。'
      if (status.phase === 'waiting-verify-code') return '请查看企业微信手机端并提交验证码。'
      if (status.phase === 'verify-code-submitted') return '验证码已提交，等待企业微信端完成登录。'
      if (status.phase === 'waiting-scan') return '请使用测试员工账号扫码完成绑定。'
      if (status.phase === 'error') return '请检查 Bridge 日志并重新尝试连接。'
      return '等待控制台完成初始化。'
    }

    function renderStatsTimeline () {
      const items = statsState.history.slice(0, 8)
      setHidden(elements.statsTimelineEmpty, items.length > 0)
      setHidden(elements.statsTimeline, items.length === 0)
      if (items.length === 0) {
        elements.statsTimeline.replaceChildren()
        return
      }
      const fragment = document.createDocumentFragment()
      items.forEach((item) => {
        const li = document.createElement('li')
        const label = document.createElement('strong')
        label.textContent = item.phase
        const text = document.createElement('span')
        text.textContent = item.at + ' · ' + item.message
        li.append(label, text)
        fragment.appendChild(li)
      })
      elements.statsTimeline.replaceChildren(fragment)
    }

    function renderStatsSuccess (status) {
      const scanCount = statsState.history.filter((item) => item.phase === 'waiting-scan').length
      const verifyCount = statsState.history.filter((item) => item.phase === 'waiting-verify-code' || item.phase === 'verify-code-submitted').length
      setText(elements.statsSyncState, '已同步')
      setHidden(elements.statsLoading, true)
      setHidden(elements.statsError, true)
      setHidden(elements.statsContent, false)
      setText(elements.statsCurrentPhase, status.phase)
      setText(elements.statsEventCount, String(statsState.history.length))
      setText(elements.statsVerifyCount, String(verifyCount))
      setText(elements.statsScanCount, String(scanCount))
      setText(elements.statsAccountUser, status.loginUser == null ? '未绑定' : ([status.loginUser.name, status.loginUser.id].filter(Boolean).join(' / ') || '未绑定'))
      setText(elements.statsLastUpdated, status.lastUpdatedAt)
      renderStatsTimeline()
    }

    function renderStatsError (message) {
      setText(elements.statsSyncState, '同步失败')
      setHidden(elements.statsLoading, true)
      setText(elements.statsErrorText, message)
      setHidden(elements.statsError, false)
      if (statsState.initialized) {
        setHidden(elements.statsContent, false)
      } else {
        setHidden(elements.statsContent, true)
      }
    }

    function updateAccountSummary (status) {
      const loginUser = status.loginUser == null
        ? '未绑定'
        : [status.loginUser.name, status.loginUser.id].filter(Boolean).join(' / ') || '未绑定'
      setText(elements.accountBoundUser, loginUser)
      setText(elements.accountLastUpdated, status.lastUpdatedAt)
      setText(elements.accountNextStep, getAccountNextStep(status))
      setText(elements.accountLinkStatus, status.phase === 'ready' ? '已连接' : (status.phase === 'logged-in' ? '已登录' : '待连接'))
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
      updateAccountSummary(status)
      setContentNotice('')

      const signature = JSON.stringify({
        phase: status.phase,
        message: status.message,
        lastUpdatedAt: status.lastUpdatedAt,
        qrCodeStatus: status.qrCodeStatus,
        loginUser,
      })
      if (statsState.lastSignature !== signature) {
        statsState.lastSignature = signature
        statsState.initialized = true
        statsState.history.unshift({
          phase: status.phase,
          message: status.message,
          at: status.lastUpdatedAt,
        })
        statsState.history = statsState.history.slice(0, 20)
        renderStatsSuccess(status)
      }

      if (typeof status.qrCodeSvg === 'string' && status.qrCodeSvg.trim() !== '') {
        renderQrSvgAsImage(status.qrCodeSvg)
      } else {
        elements.bridgeQr.textContent = '当前没有可展示的二维码。'
        elements.bridgeQr.classList.add('muted')
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
        image.style.width = 'min(100%, 280px)'
        image.style.height = 'auto'
        elements.bridgeQr.classList.remove('muted')
        elements.bridgeQr.replaceChildren(image)
      } catch {
        elements.bridgeQr.textContent = '二维码渲染失败，请等待刷新。'
        elements.bridgeQr.classList.add('muted')
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
      }
      if (!statusResponse.response.ok) {
        throw new Error(statusResponse.payload.error || '无法获取状态')
      }
      updateBridgeCards(statusResponse.payload)
      connectEvents()
    }

    elements.navButtons.forEach((button) => {
      if (!button.dataset.nav) {
        return
      }
      button.addEventListener('click', () => {
        setActivePage(button.dataset.nav)
      })
    })

    elements.settingsNavToggle.addEventListener('click', () => {
      settingsExpanded = !settingsExpanded
      syncSettingsNavigation()
    })

    elements.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      setLoginError('')
      const username = elements.loginUsername.value.trim()
      const password = elements.loginPassword.value
      if (username !== 'admin') {
        setLoginError('当前控制台用户名固定为 admin。')
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
          throw new Error(created.payload.error || '访问令牌错误，请重试。')
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
      setAccountMenuOpen(false)
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
        setContentNotice(error instanceof Error ? error.message : String(error))
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

    elements.toolLibrarySearch.addEventListener('input', () => {
      const filterState = computeToolLibraryFilterState(
        elements.toolLibraryItems.map((item) => ({
          title: item.dataset.title ?? '',
          tags: item.dataset.tags ?? '',
        })),
        elements.toolLibrarySearch.value,
      )
      elements.toolLibraryItems.forEach((item, index) => {
        const hidden = !filterState.visibleIndexes.includes(index)
        item.classList.toggle('hidden', hidden)
      })
      setHidden(elements.toolLibraryEmpty, !filterState.empty)
      setText(elements.toolLibraryStatus, filterState.statusText)
    })

    function openToolModal (name, triggerButton) {
      lastToolTrigger = triggerButton ?? null
      setText(elements.toolModalTitle, name)
      setText(elements.toolModalContent, toolDescriptions[name] || '工具详情待补充')
      setHidden(elements.toolModalMask, false)
      elements.toolModalClose.focus()
    }

    elements.toolButtons.forEach((button) => {
      button.addEventListener('click', () => {
        openToolModal(button.dataset.tool || '工具', button)
      })
    })

    function closeToolModal () {
      setHidden(elements.toolModalMask, true)
      if (lastToolTrigger && typeof lastToolTrigger.focus === 'function') {
        lastToolTrigger.focus()
      }
      lastToolTrigger = null
    }

    elements.toolModalClose.addEventListener('click', closeToolModal)
    elements.toolModalMask.addEventListener('click', (event) => {
      if (event.target === elements.toolModalMask) {
        closeToolModal()
      }
    })

    document.addEventListener('keydown', (event) => {
      if (!elements.toolModalMask.classList.contains('hidden') && event.key === 'Tab') {
        const focusables = Array.from(elements.toolModalMask.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hasAttribute('disabled'))
        if (focusables.length > 0) {
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement
          if (!focusables.includes(active)) {
            event.preventDefault()
            if (event.shiftKey) {
              last.focus()
            } else {
              first.focus()
            }
          } else if (event.shiftKey && active === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }
      if (event.key === 'Escape' && !elements.toolModalMask.classList.contains('hidden')) {
        closeToolModal()
      }
      if (event.key === 'Escape' && !elements.accountMenuPanel.classList.contains('hidden')) {
        setAccountMenuOpen(false)
        elements.accountMenuTrigger.focus()
      }
    })

    function setRagFeedback (text) {
      setText(elements.ragFeedback, text)
    }

    function handleRagSearchSubmit () {
      const query = elements.ragQuery.value.trim()
      if (!query) {
        setRagFeedback('请输入关键词后再检索。')
        return false
      }
      setRagFeedback('已收到“' + query + '”的检索请求，待后端知识库检索接口接入后展示真实结果。')
      return true
    }

    elements.ragForm.addEventListener('submit', (event) => {
      event.preventDefault()
      handleRagSearchSubmit()
    })

    elements.ragAdd.addEventListener('click', () => {
      setRagFeedback('已收到添加文档请求，当前控制台仅保留入口，待后端持久化能力接入。')
    })

    elements.modelConfigForm.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!hasPermission('manageModels')) {
        renderModelConfigState('当前账号没有模型配置权限。')
        elements.modelApiKey.value = ''
        return
      }
      Object.assign(modelConfigState, computeNextModelConfigState(modelConfigState, {
        provider: elements.modelProvider.value,
        baseUrl: elements.modelBaseUrl.value,
        model: elements.modelName.value,
        timeoutMs: elements.modelTimeout.value,
        enabled: elements.modelEnabled.checked,
        apiKeyValue: elements.modelApiKey.value,
        clearApiKey: elements.modelClearApiKey.checked,
      }))
      elements.modelApiKey.value = ''
      renderModelConfigState('已保存到当前页面内存状态；仓库尚未接入持久化模型配置 API，API Key 未回显。')
    })

    elements.modelConfigReset.addEventListener('click', () => {
      renderModelConfigState('已恢复为当前页面记录的临时配置。')
      elements.modelApiKey.value = ''
    })

    function applyRouteState (focusPageTitle) {
      const route = deriveRouteState()
      setActiveToolGroup(route.toolGroup)
      setActivePage(route.page, { updateHash: false, focus: focusPageTitle && !route.scrollToAssets })
      if (focusPageTitle && route.scrollToAssets) {
        const toolLibrarySection = document.getElementById('tool-library-section')
        if (toolLibrarySection) {
          toolLibrarySection.scrollIntoView({ block: 'start' })
        }
        elements.toolLibrarySearch.focus()
      }
    }

    window.addEventListener('hashchange', () => {
      applyRouteState(true)
    })
    window.addEventListener('popstate', () => {
      applyRouteState(true)
    })
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Node)) {
        return
      }
      if (!elements.accountMenuPanel.classList.contains('hidden')
        && !elements.accountMenuPanel.contains(event.target)
        && !elements.accountMenuTrigger.contains(event.target)) {
        setAccountMenuOpen(false)
      }
    })
    elements.accountMenuTrigger.addEventListener('click', () => {
      const expanded = elements.accountMenuTrigger.getAttribute('aria-expanded') === 'true'
      if (expanded) {
        setAccountMenuOpen(false)
        return
      }
      openAccountMenu()
    })
    elements.accountMenuTrigger.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') {
        return
      }
      event.preventDefault()
      openAccountMenu(true)
    })

    applyPermissionGuards()
    renderModelConfigState('尚未保存临时配置。')
    applyRouteState(false)
    void refreshStatus().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      renderStatsError(message)
      if (bootstrap.tokenRequired) {
        showLoginScreen()
        setLoginError(message)
        return
      }
      showAppScreen()
      setText(elements.bridgePhase, 'error')
      setText(elements.bridgeMessage, message)
      setContentNotice(message)
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
