import { describe, expect, it, vi } from 'vitest'
import { HttpBridgeApiClient, WechatyWorkProBridge, createBridgeApplication, createConsoleLogger, loadConfig, type BridgeApiClient, type BridgeConfig, type BridgeLogger } from '../src/service'

function createConfig (overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    puppetServiceToken: 'token',
    puppetServiceAuthority: 'token-service-discovery-test.juzibot.com',
    aiApiBaseUrl: 'http://app:8000',
    aiBridgeToken: 'bridge-token',
    webHost: '127.0.0.1',
    webPort: 18080,
    webToken: 'bridge-web-token',
    webSessionTtlMs: 60_000,
    webVerifyTimeoutMs: 300_000,
    messageTimeoutMs: 20000,
    apiMaxRetries: 1,
    replyMaxLength: 20,
    maxMessageAgeSeconds: 180,
    contactWhitelist: new Set<string>(),
    fallbackReply: 'fallback reply',
    autoAcceptFriendship: false,
    staffUserid: '',
    ...overrides,
  }
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

function createMessage (overrides: {
  id?: string
  text?: string
  self?: boolean
  room?: object | null
  type?: number
  date?: Date
  contactId?: string
  staffUserid?: string
  sayImpl?: (reply: string) => Promise<void>
} = {}) {
  const replies: string[] = []
  const say = vi.fn(async (reply: string) => {
    replies.push(reply)
    await (overrides.sayImpl?.(reply) ?? Promise.resolve())
  })

  const listener = {
    currentUser: { id: overrides.staffUserid ?? 'staff-1' },
  }

  const talker = {
    id: overrides.contactId ?? 'contact-1',
  }

  return {
    message: {
      id: overrides.id ?? 'msg-1',
      self: vi.fn().mockResolvedValue(overrides.self ?? false),
      room: vi.fn(() => overrides.room ?? null),
      type: vi.fn(() => overrides.type ?? 7),
      date: vi.fn(() => overrides.date ?? new Date()),
      talker: vi.fn(() => talker),
      listener: vi.fn(() => listener),
      text: vi.fn(() => overrides.text ?? '你好'),
      say,
    },
    replies,
  }
}

describe('loadConfig', () => {
  it('requires mandatory tokens and parses whitelist', () => {
    const config = loadConfig({
      WECHATY_PUPPET_SERVICE_TOKEN: 'workpro-token',
      AI_BRIDGE_TOKEN: 'bridge-token',
      BRIDGE_CONTACT_WHITELIST: 'contact-1, contact-2 ',
    })
    expect(config.puppetServiceAuthority).toBe('token-service-discovery-test.juzibot.com')
    expect(Array.from(config.contactWhitelist)).toEqual(['contact-1', 'contact-2'])
    expect(config.webHost).toBe('127.0.0.1')
    expect(config.webPort).toBe(18080)
  })

  it('requires a web token when the control plane binds beyond loopback', () => {
    expect(() => loadConfig({
      WECHATY_PUPPET_SERVICE_TOKEN: 'workpro-token',
      AI_BRIDGE_TOKEN: 'bridge-token',
      BRIDGE_WEB_HOST: '0.0.0.0',
    })).not.toThrow()

    expect(() => createBridgeApplication(createConfig({
      webHost: '0.0.0.0',
      webToken: '',
    }), vi.fn() as unknown as typeof fetch, createLogger().logger)).toThrow(
      'BRIDGE_WEB_TOKEN is required when BRIDGE_WEB_HOST is not loopback',
    )
  })
})

describe('WechatyWorkProBridge', () => {
  it('creates the bridge application without requiring a real token at test time', () => {
    const app = createBridgeApplication(createConfig(), vi.fn() as unknown as typeof fetch, createLogger().logger)

    expect(app.bot).toBeDefined()
    expect(app.bridge).toBeInstanceOf(WechatyWorkProBridge)
    expect(typeof app.start).toBe('function')
  })

  it('friendship defaults to deny and only accepts receive on explicit config', async () => {
    const apiClient: BridgeApiClient = { requestReply: vi.fn() }
    const { logger } = createLogger()
    const defaultBridge = new WechatyWorkProBridge(createConfig(), apiClient, logger)
    const acceptingBridge = new WechatyWorkProBridge(
      createConfig({ autoAcceptFriendship: true }),
      apiClient,
      logger,
    )
    const receiveAccept = vi.fn(async () => {})
    const confirmAccept = vi.fn(async () => {})

    await defaultBridge.handleFriendship({ type: () => 2, accept: receiveAccept })
    await acceptingBridge.handleFriendship({ type: () => 1, accept: confirmAccept })
    await acceptingBridge.handleFriendship({ type: () => 2, accept: receiveAccept })

    expect(receiveAccept).toHaveBeenCalledOnce()
    expect(confirmAccept).not.toHaveBeenCalled()
  })

  it('room joins are audit only', () => {
    const apiClient: BridgeApiClient = { requestReply: vi.fn() }
    const { logger, records } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig(), apiClient, logger)

    bridge.handleRoomJoin({ id: 'room-123456' }, [{ id: 'invitee-1' }])

    expect(records).toContainEqual({
      level: 'info',
      message: 'room-join observed',
      fields: { roomId: 'ro***56', inviteeCount: 1 },
    })
  })

  it('ignores self, non-text, room, and stale messages', async () => {
    const apiClient: BridgeApiClient = { requestReply: vi.fn() }
    const { logger, records } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig(), apiClient, logger, () => Date.now())

    await bridge.handleMessage(createMessage({ self: true }).message as never)
    await bridge.handleMessage(createMessage({ id: 'msg-2', type: 6 }).message as never)
    await bridge.handleMessage(createMessage({ id: 'msg-3', room: {} }).message as never)
    await bridge.handleMessage(
      createMessage({ id: 'msg-4', date: new Date(Date.now() - 500000) }).message as never,
    )

    expect(apiClient.requestReply).not.toHaveBeenCalled()
    expect(records.map((record) => record.message)).toContain('ignored self message')
    expect(records.map((record) => record.message)).toContain('ignored non-text message')
    expect(records.map((record) => record.message)).toContain('ignored room message')
    expect(records.map((record) => record.message)).toContain('ignored stale message')
  })

  it('replies successfully and strips oversized output', async () => {
    const apiClient: BridgeApiClient = {
      requestReply: vi.fn().mockResolvedValue({
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        reply: '这是一个非常长非常长非常长的回复',
        correlation_id: 'corr-1',
      }),
    }
    const { logger, records } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig({ replyMaxLength: 8 }), apiClient, logger)
    const { message, replies } = createMessage()

    await bridge.handleMessage(message as never)

    expect(apiClient.requestReply).toHaveBeenCalledOnce()
    expect(replies).toEqual(['这是一个非常长…'])
    expect(records.find((record) => record.message === 'replied to contact message')?.fields?.replyLength).toBe(8)
  })

  it('deduplicates repeated message ids', async () => {
    const apiClient: BridgeApiClient = {
      requestReply: vi.fn().mockResolvedValue({
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        reply: 'ok',
        correlation_id: 'corr-1',
      }),
    }
    const { logger } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig(), apiClient, logger)
    const first = createMessage({ id: 'same-msg' })
    const second = createMessage({ id: 'same-msg' })

    await bridge.handleMessage(first.message as never)
    await bridge.handleMessage(second.message as never)

    expect(apiClient.requestReply).toHaveBeenCalledOnce()
    expect(second.replies).toEqual([])
  })

  it('serializes processing for the same contact', async () => {
    const order: string[] = []
    const resolvers: Array<() => void> = []
    const apiClient: BridgeApiClient = {
      requestReply: vi.fn().mockImplementation(async ({ messageId }) => {
        order.push(`start:${messageId}`)
        await new Promise<void>((resolve) => {
          resolvers.push(() => {
            order.push(`finish:${messageId}`)
            resolve()
          })
        })
        return {
          conversation_id: 'conv-1',
          message_id: messageId,
          reply: messageId,
          correlation_id: `corr:${messageId}`,
        }
      }),
    }
    const { logger } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig(), apiClient, logger)
    const first = createMessage({ id: 'msg-1', contactId: 'contact-serial' })
    const second = createMessage({ id: 'msg-2', contactId: 'contact-serial' })

    const firstPromise = bridge.handleMessage(first.message as never)
    const secondPromise = bridge.handleMessage(second.message as never)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['start:msg-1'])
    resolvers.shift()?.()
    await firstPromise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['start:msg-1', 'finish:msg-1', 'start:msg-2'])
    resolvers.shift()?.()
    await secondPromise
    expect(order).toEqual(['start:msg-1', 'finish:msg-1', 'start:msg-2', 'finish:msg-2'])
  })

  it('uses fallback reply on api failure', async () => {
    const apiClient: BridgeApiClient = {
      requestReply: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const { logger, records } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig({ fallbackReply: '稍后再试' }), apiClient, logger)
    const { message, replies } = createMessage()

    await bridge.handleMessage(message as never)

    expect(replies).toEqual(['稍后再试'])
    expect(records.find((record) => record.message === 'bridge api failed, used fallback reply')?.fields?.errorCode).toBe('Error')
  })

  it('does not log full customer text or token values', async () => {
    const apiClient: BridgeApiClient = {
      requestReply: vi.fn().mockResolvedValue({
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        reply: 'ok',
        correlation_id: 'corr-1',
      }),
    }
    const { logger, records } = createLogger()
    const bridge = new WechatyWorkProBridge(
      createConfig({ aiBridgeToken: 'secret-bridge-token' }),
      apiClient,
      logger,
    )
    const { message } = createMessage({ text: '客户完整消息正文' })

    await bridge.handleMessage(message as never)

    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('客户完整消息正文')
    expect(serialized).not.toContain('secret-bridge-token')
  })

  it('redacts error logs', () => {
    const apiClient: BridgeApiClient = { requestReply: vi.fn() }
    const { logger, records } = createLogger()
    const bridge = new WechatyWorkProBridge(createConfig(), apiClient, logger)

    bridge.handleError(new Error('request failed with token=abc123 and ******'))

    expect(records).toContainEqual({
      level: 'error',
      message: 'wechaty error event',
      fields: {
        errorCode: 'Error',
        errorMessage: 'request failed with token=[REDACTED] and ******',
      },
    })
  })

  it('skips contacts outside whitelist', async () => {
    const apiClient: BridgeApiClient = { requestReply: vi.fn() }
    const { logger } = createLogger()
    const bridge = new WechatyWorkProBridge(
      createConfig({ contactWhitelist: new Set(['contact-allowed']) }),
      apiClient,
      logger,
    )

    await bridge.handleMessage(createMessage({ contactId: 'contact-blocked' }).message as never)

    expect(apiClient.requestReply).not.toHaveBeenCalled()
  })
})

describe('createConsoleLogger', () => {
  it('returns logger methods', () => {
    const logger = createConsoleLogger()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })
})

describe('HttpBridgeApiClient', () => {
  it('retries within the configured boundary', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversation_id: 'conv-1',
          message_id: 'msg-1',
          reply: '重试成功',
          correlation_id: 'corr-1',
        }),
      })
    const client = new HttpBridgeApiClient(createConfig({ apiMaxRetries: 1 }), fetchImpl as unknown as typeof fetch)

    const result = await client.requestReply({
      conversationKey: 'wechaty-workpro:staff-1:contact-1',
      contactId: 'contact-1',
      staffUserid: 'staff-1',
      messageId: 'msg-1',
      text: '你好',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.reply).toBe('重试成功')
  })
})
