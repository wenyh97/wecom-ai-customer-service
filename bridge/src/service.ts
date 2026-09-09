import qrcodeTerminal from 'qrcode-terminal'
import { ScanStatus, WechatyBuilder, log, types, type Contact, type Message, type Wechaty } from 'wechaty'

export interface BridgeConfig {
  puppet: string
  puppetServiceToken: string
  aiApiBaseUrl: string
  aiBridgeToken: string
  messageTimeoutMs: number
  apiMaxRetries: number
  replyMaxLength: number
  maxMessageAgeSeconds: number
  contactWhitelist: Set<string>
  fallbackReply: string
}

export interface BridgeLogger {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  error: (message: string, fields?: Record<string, unknown>) => void
}

export interface BridgeApiReply {
  conversation_id: string
  message_id: string
  reply: string
  correlation_id: string
}

export interface BridgeApiClient {
  requestReply: (payload: {
    conversationKey: string
    contactId: string
    staffUserid: string
    messageId: string
    text: string
  }) => Promise<BridgeApiReply>
}

const DEFAULT_FALLBACK_REPLY = '抱歉，当前 AI 服务暂时不可用，请稍后再试或联系人工客服。'

function envNumber (value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig (env: NodeJS.ProcessEnv): BridgeConfig {
  const puppetServiceToken = (env.WECHATY_PUPPET_SERVICE_TOKEN ?? '').trim()
  const aiBridgeToken = (env.AI_BRIDGE_TOKEN ?? '').trim()
  const aiApiBaseUrl = (env.AI_API_BASE_URL ?? 'http://127.0.0.1:8000').trim().replace(/\/$/, '')
  if (puppetServiceToken === '') {
    throw new Error('WECHATY_PUPPET_SERVICE_TOKEN is required')
  }
  if (aiBridgeToken === '') {
    throw new Error('AI_BRIDGE_TOKEN is required')
  }

  const whitelistItems = (env.BRIDGE_CONTACT_WHITELIST ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return {
    puppet: (env.WECHATY_PUPPET ?? 'wechaty-puppet-service').trim() || 'wechaty-puppet-service',
    puppetServiceToken,
    aiApiBaseUrl,
    aiBridgeToken,
    messageTimeoutMs: envNumber(env.BRIDGE_MESSAGE_TIMEOUT_MS, 20000),
    apiMaxRetries: Math.max(0, envNumber(env.BRIDGE_API_MAX_RETRIES, 1)),
    replyMaxLength: envNumber(env.BRIDGE_REPLY_MAX_LENGTH, 500),
    maxMessageAgeSeconds: envNumber(env.BRIDGE_MAX_MESSAGE_AGE_SECONDS, 180),
    contactWhitelist: new Set(whitelistItems),
    fallbackReply: DEFAULT_FALLBACK_REPLY,
  }
}

export function createConsoleLogger (): BridgeLogger {
  return {
    info: (message, fields = {}) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
    warn: (message, fields = {}) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
    error: (message, fields = {}) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
  }
}

export class HttpBridgeApiClient implements BridgeApiClient {
  constructor (
    private readonly config: BridgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async requestReply (payload: {
    conversationKey: string
    contactId: string
    staffUserid: string
    messageId: string
    text: string
  }): Promise<BridgeApiReply> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.messageTimeoutMs)
    try {
      let lastError: Error | undefined
      for (let attempt = 0; attempt <= this.config.apiMaxRetries; attempt += 1) {
        try {
          const response = await this.fetchImpl(`${this.config.aiApiBaseUrl}/internal/chat`, {
            method: 'POST',
            headers: {
              Authorization: ['Bearer', this.config.aiBridgeToken].join(' '),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              conversation_key: payload.conversationKey,
              contact_id: payload.contactId,
              staff_userid: payload.staffUserid,
              message_id: payload.messageId,
              text: payload.text,
            }),
            signal: controller.signal,
          })
          if (!response.ok) {
            throw new Error(`bridge api returned ${response.status}`)
          }
          return await response.json() as BridgeApiReply
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (attempt >= this.config.apiMaxRetries) {
            throw lastError
          }
        }
      }
      throw lastError ?? new Error('bridge api request failed')
    } finally {
      clearTimeout(timeout)
    }
  }
}

function truncateReply (reply: string, maxLength: number): string {
  const trimmed = reply.trim()
  if (trimmed === '') {
    return ''
  }
  if (trimmed.length <= maxLength) {
    return trimmed
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`
}

function resolveStaffUserid (message: Message): string {
  const withListener = message as unknown as {
    listener?: () => { currentUser?: { id?: string } } | undefined
    wechaty?: { currentUser?: { id?: string } }
  }
  return (
    withListener.listener?.()?.currentUser?.id ??
    withListener.wechaty?.currentUser?.id ??
    ''
  )
}

export class WechatyWorkProBridge {
  private readonly processedMessageIds = new Set<string>()
  private readonly contactQueues = new Map<string, Promise<void>>()

  constructor (
    private readonly config: BridgeConfig,
    private readonly apiClient: BridgeApiClient,
    private readonly logger: BridgeLogger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async handleMessage (message: Message): Promise<void> {
    if (await message.self()) {
      this.logger.info('ignored self message', { messageId: message.id })
      return
    }
    if (message.room() != null) {
      this.logger.info('ignored room message', { messageId: message.id })
      return
    }
    if (message.type() !== types.Message.Text) {
      this.logger.info('ignored non-text message', { messageId: message.id })
      return
    }

    const sentAt = message.date()
    if (sentAt != null && ((this.now() - sentAt.getTime()) / 1000) > this.config.maxMessageAgeSeconds) {
      this.logger.info('ignored stale message', { messageId: message.id })
      return
    }

    const talker = message.talker()
    const contactId = talker.id
    if (this.config.contactWhitelist.size > 0 && !this.config.contactWhitelist.has(contactId)) {
      this.logger.info('ignored non-whitelisted contact', { contactId, messageId: message.id })
      return
    }

    if (this.processedMessageIds.has(message.id)) {
      this.logger.info('ignored duplicate message', { contactId, messageId: message.id })
      return
    }
    this.processedMessageIds.add(message.id)

    const prior = this.contactQueues.get(contactId) ?? Promise.resolve()
    const queued = prior
      .catch(() => {})
      .then(async () => { await this.processTextMessage(message, talker) })
      .finally(() => {
        if (this.contactQueues.get(contactId) === queued) {
          this.contactQueues.delete(contactId)
        }
      })

    this.contactQueues.set(contactId, queued)
    await queued
  }

  private async processTextMessage (message: Message, talker: Contact): Promise<void> {
    const contactId = talker.id
    const staffUserid = resolveStaffUserid(message).trim()
    const text = message.text().trim()
    const conversationKey = `wechaty-workpro:${staffUserid}:${contactId}`

    if (text === '' || staffUserid === '') {
      this.logger.warn('ignored invalid message payload', {
        contactId,
        messageId: message.id,
        hasText: text !== '',
        hasStaffUserid: staffUserid !== '',
      })
      return
    }

    this.logger.info('processing contact message', {
      contactId,
      staffUserid,
      messageId: message.id,
      textLength: text.length,
    })

    try {
      const response = await this.apiClient.requestReply({
        conversationKey,
        contactId,
        staffUserid,
        messageId: message.id,
        text,
      })
      const reply = truncateReply(response.reply, this.config.replyMaxLength)
      await message.say(reply !== '' ? reply : this.config.fallbackReply)
      this.logger.info('replied to contact message', {
        contactId,
        staffUserid,
        messageId: message.id,
        replyLength: (reply !== '' ? reply : this.config.fallbackReply).length,
        conversationId: response.conversation_id,
      })
    } catch (error) {
      await message.say(this.config.fallbackReply)
      this.logger.warn('bridge api failed, used fallback reply', {
        contactId,
        staffUserid,
        messageId: message.id,
        errorCode: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
}

export function attachWechatyHandlers (
  bot: Wechaty,
  bridge: WechatyWorkProBridge,
  logger: BridgeLogger,
): void {
  bot
    .on('scan', (qrcode: string, status: number) => {
      logger.info('wechaty scan event', { status: ScanStatus[status] ?? status })
      qrcodeTerminal.generate(qrcode, { small: true })
      log.info('Scan the QR code above to log in with the dedicated enterprise WeCom test account.')
    })
    .on('login', (user: { id: string, name: () => string }) => {
      logger.info('wechaty login event', { userId: user.id, name: user.name() })
    })
    .on('logout', (user: { id: string, name: () => string }) => {
      logger.info('wechaty logout event', { userId: user.id, name: user.name() })
    })
    .on('ready', () => {
      logger.info('wechaty ready event')
    })
    .on('error', (error: unknown) => {
      logger.error('wechaty error event', {
        errorCode: error instanceof Error ? error.name : 'unknown',
      })
    })
    .on('message', (message: Message) => {
      void bridge.handleMessage(message).catch((error) => {
        logger.error('wechaty message handler failed', {
          messageId: message.id,
          errorCode: error instanceof Error ? error.name : 'unknown',
        })
      })
    })
}

export function createWechatyBot (config: BridgeConfig): Wechaty {
  return WechatyBuilder.build({
    name: 'workpro-bridge',
    puppet: config.puppet as 'wechaty-puppet-service',
    puppetOptions: {
      token: config.puppetServiceToken,
    },
  })
}

export function createBridgeApplication (
  config: BridgeConfig,
  fetchImpl: typeof fetch = fetch,
  logger: BridgeLogger = createConsoleLogger(),
): { bot: Wechaty, bridge: WechatyWorkProBridge, start: () => Promise<void> } {
  const bot = createWechatyBot(config)
  const apiClient = new HttpBridgeApiClient(config, fetchImpl)
  const bridge = new WechatyWorkProBridge(config, apiClient, logger)
  attachWechatyHandlers(bot, bridge, logger)
  return {
    bot,
    bridge,
    start: async () => { await bot.start() },
  }
}
