import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import http from 'node:http'

import type { BridgeLogger } from '../src/service'
import { BridgeWebControlPlane, type BridgeWebConfig } from '../src/web-control'
import { createVerifyCodeSubmitter } from '../src/verify-code'
import type { VerifyCodeSubmitter } from '../src/verify-code'

class FakeBot extends EventEmitter {
  enterVerifyCode = vi.fn(async () => {})
  cancelVerifyCode = vi.fn(async () => {})
}

function createLogger (): { logger: BridgeLogger, records: Array<{ level: string, message: string, fields?: Record<string, unknown> }> } {
  const records: Array<{ level: string, message: string, fields?: Record<string, unknown> }> = []
  return {
    logger: {
      info: (message, fields) => { records.push({ level: 'info', message, fields }) },
      warn: (message, fields) => { records.push({ level: 'warn', message, fields }) },
      error: (message, fields) => { records.push({ level: 'error', message, fields }) },
    },
    records,
  }
}

function createWebConfig (overrides: Partial<BridgeWebConfig> = {}): BridgeWebConfig {
  return {
    webHost: '127.0.0.1',
    webPort: 0,
    webToken: 'bridge-web-token',
    webSessionTtlMs: 60_000,
    webVerifyTimeoutMs: 300_000,
    ...overrides,
  }
}

async function createSession (baseUrl: string, token = 'bridge-web-token'): Promise<{ cookie: string, csrfToken: string }> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  })
  const payload = await response.json() as { csrfToken: string }
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!response.ok || !cookie) {
    throw new Error('failed to create authenticated session')
  }
  return {
    cookie,
    csrfToken: payload.csrfToken,
  }
}

async function readFirstSseChunk (url: string, cookie: string): Promise<{ status: number, contentType: string | null, body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Cookie: cookie } }, (response) => {
      const chunks: string[] = []
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        chunks.push(chunk)
        request.destroy()
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers['content-type'] ?? null,
          body: chunks.join(''),
        })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
  })
}

describe('createVerifyCodeSubmitter', () => {
  it('uses the low-level grpc client path when available', async () => {
    const enterVerifyCode = vi.fn((request: { getId: () => string, getCode: () => string }, callback: (error: Error | null) => void) => {
      expect(request.getId()).toBe('verify-id')
      expect(request.getCode()).toBe('123456')
      callback(null)
    })
    const cancelVerifyCode = vi.fn((request: { getId: () => string }, callback: (error: Error | null) => void) => {
      expect(request.getId()).toBe('verify-id')
      callback(null)
    })
    const bot = {
      puppet: {
        grpcManager: {
          client: {
            enterVerifyCode,
            cancelVerifyCode,
          },
        },
      },
      enterVerifyCode: vi.fn(async () => {}),
      cancelVerifyCode: vi.fn(async () => {}),
    } as unknown as FakeBot

    const submitter = createVerifyCodeSubmitter(bot as never)

    expect(submitter.mode).toBe('grpc-client')
    await submitter.submit('verify-id', '123456')
    await submitter.cancel('verify-id')
    expect(enterVerifyCode).toHaveBeenCalledOnce()
    expect(cancelVerifyCode).toHaveBeenCalledOnce()
    expect((bot.enterVerifyCode as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

describe('BridgeWebControlPlane', () => {
  const startedControllers: BridgeWebControlPlane[] = []

  afterEach(async () => {
    await Promise.all(startedControllers.splice(0).map(async (controller) => {
      await controller.stop().catch(() => {})
    }))
    vi.restoreAllMocks()
  })

  async function startControlPlane (options: {
    config?: Partial<BridgeWebConfig>
    submitter?: Partial<VerifyCodeSubmitter>
    now?: () => number
  } = {}): Promise<{ controller: BridgeWebControlPlane, bot: FakeBot, baseUrl: string, records: ReturnType<typeof createLogger>['records'] }> {
    const bot = new FakeBot()
    const { logger, records } = createLogger()
    const submitter: VerifyCodeSubmitter = {
      mode: 'grpc-client',
      submit: options.submitter?.submit ?? vi.fn(async () => {}),
      cancel: options.submitter?.cancel ?? vi.fn(async () => {}),
    }
    const controller = new BridgeWebControlPlane(
      createWebConfig(options.config),
      bot as never,
      submitter,
      logger,
      options.now,
    )
    await controller.start()
    startedControllers.push(controller)
    return {
      controller,
      bot,
      baseUrl: controller.url,
      records,
    }
  }

  it('stores scan state, exposes SVG via the authenticated status API, and streams SSE updates', async () => {
    const { baseUrl, bot } = await startControlPlane()
    const { cookie } = await createSession(baseUrl)

    bot.emit('scan', 'https://workpro.example/qr?secret=abc', 2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const statusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie },
    })
    const status = await statusResponse.json() as { phase: string, qrCodeSvg: string | null, qrCodeStatus: string }
    const sse = await readFirstSseChunk(`${baseUrl}/api/events`, cookie)

    expect(statusResponse.status).toBe(200)
    expect(status.phase).toBe('waiting-scan')
    expect(status.qrCodeSvg).toContain('<svg')
    expect(status.qrCodeStatus).toBe('Waiting')
    expect(JSON.stringify(status)).not.toContain('secret=abc')
    expect(sse.status).toBe(200)
    expect(sse.contentType).toContain('text/event-stream')
    expect(sse.body).toContain('waiting-scan')
  })

  it('renders the WeCom assistant admin console with focused login controls', async () => {
    const { baseUrl } = await startControlPlane()

    const response = await fetch(`${baseUrl}/`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<title>企微智能助手管理后台</title>')
    expect(html).toContain('企微智能助手')
    expect(html).toContain('管理后台')
    expect(html).toContain('id="login-username"')
    expect(html).toContain('value="admin"')
    expect(html).toContain('账号固定为 admin')
    expect(html).toContain('当前登录状态')
    expect(html).toContain('id="sidebar-login-user"')
    expect(html).toContain('企业微信接入')
    expect(html).toContain('登录指引')
    expect(html).not.toContain('营销工作台')
    expect(html).not.toContain('对话创作')
    expect(html).not.toContain('内容资产')
    expect(html).toContain('id="bridge-qr"')
    expect(html).toContain('id="verify-form"')
    expect(html).toContain('/api/session')
    expect(html).toContain('/api/status')
    expect(html).toContain('/api/events')
    expect(html).toContain('/api/verify-code')
  })

  it('requires authentication and csrf protection for verify-code submission', async () => {
    const submit = vi.fn(async () => {})
    const { baseUrl, bot } = await startControlPlane({ submitter: { submit } })
    const { cookie, csrfToken } = await createSession(baseUrl)

    bot.emit('verify-code', 'event-1', '请输入企业微信手机端展示的验证码，以继续登录', 1, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const status = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).json() as {
      verifyCode: { requestId: string }
    }

    const unauthenticated = await fetch(`${baseUrl}/api/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
      body: JSON.stringify({ requestId: status.verifyCode.requestId, code: '123456' }),
    })
    const missingCsrf = await fetch(`${baseUrl}/api/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: baseUrl,
      },
      body: JSON.stringify({ requestId: status.verifyCode.requestId, code: '123456' }),
    })

    expect(unauthenticated.status).toBe(401)
    expect(missingCsrf.status).toBe(403)
    expect(submit).not.toHaveBeenCalled()

    const success = await fetch(`${baseUrl}/api/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: baseUrl,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ requestId: status.verifyCode.requestId, code: '123456' }),
    })
    const payload = await success.json() as { status: { phase: string, verifyCode: { submittedAt: string | null } } }

    expect(success.status).toBe(200)
    expect(submit).toHaveBeenCalledWith('event-1', '123456')
    expect(payload.status.phase).toBe('verify-code-submitted')
    expect(payload.status.verifyCode.submittedAt).not.toBeNull()
    expect(JSON.stringify(payload)).not.toContain('123456')
    expect(JSON.stringify(payload)).not.toContain('event-1')

    const repeated = await fetch(`${baseUrl}/api/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: baseUrl,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ requestId: status.verifyCode.requestId, code: '123456' }),
    })

    expect(repeated.status).toBe(409)
  })

  it('destroys session on authenticated logout request', async () => {
    const { baseUrl } = await startControlPlane()
    const { cookie, csrfToken } = await createSession(baseUrl)

    const logout = await fetch(`${baseUrl}/api/session`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        Origin: baseUrl,
        'X-CSRF-Token': csrfToken,
      },
    })
    const payload = await logout.json() as { ok: boolean }

    expect(logout.status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')

    const statusAfterLogout = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie },
    })
    expect(statusAfterLogout.status).toBe(401)
  })

  it('handles invalid format, submit errors, timeout, and state cleanup without leaking codes', async () => {
    const cancel = vi.fn(async () => {})
    const submit = vi.fn(async () => {
      throw new Error('bad verify code 654321')
    })
    const { baseUrl, bot, records } = await startControlPlane({
      config: { webVerifyTimeoutMs: 20 },
      submitter: { submit, cancel },
    })
    const { cookie, csrfToken } = await createSession(baseUrl)

    bot.emit('scan', 'https://workpro.example/qr?secret=xyz', 2)
    bot.emit('verify-code', 'event-2', '请输入验证码', 1, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const initial = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).json() as {
      qrCodeSvg: string | null
      verifyCode: { requestId: string }
    }

    const invalid = await fetch(`${baseUrl}/api/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: baseUrl,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ requestId: initial.verifyCode.requestId, code: '12 34' }),
    })
    expect(invalid.status).toBe(400)

    const failed = await fetch(`${baseUrl}/api/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: baseUrl,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ requestId: initial.verifyCode.requestId, code: '654321' }),
    })
    const failedPayload = await failed.json() as { error: string }
    const failedStatus = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).json() as {
      phase: string
      message: string
      verifyCode: { lastError: string | null }
      qrCodeSvg: string | null
    }

    expect(failed.status).toBe(502)
    expect(failedPayload.error).toBe('验证码提交失败，请核对后重试。')
    expect(failedStatus.phase).toBe('waiting-verify-code')
    expect(failedStatus.verifyCode.lastError).toBe('验证码提交失败，请核对后重试。')
    expect(JSON.stringify(failedStatus)).not.toContain('654321')
    expect(JSON.stringify(records)).not.toContain('654321')

    bot.emit('verify-code', 'event-3', '请输入新的验证码', 1, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 25))
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledWith('event-3')
    })
    const expiredStatus = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).json() as {
      phase: string
      verifyCode: null
      qrCodeSvg: string | null
    }

    expect(expiredStatus.phase).toBe('verify-code-expired')
    expect(expiredStatus.verifyCode).toBeNull()
    expect(expiredStatus.qrCodeSvg).toBeNull()

    bot.emit('login', { id: 'login-user-123456', name: () => 'Tester' })
    bot.emit('ready')
    const readyStatus = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).json() as {
      phase: string
      qrCodeSvg: string | null
      loginUser: { id: string | null, name: string | null }
    }

    expect(readyStatus.phase).toBe('ready')
    expect(readyStatus.qrCodeSvg).toBeNull()
    expect(readyStatus.loginUser).toEqual({ id: 'lo***56', name: 'Tester' })
  })
})
