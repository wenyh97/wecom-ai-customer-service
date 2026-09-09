import { WechatyBuilder, types } from '@juzi/wechaty'
import '@juzi/wechaty-puppet-service'

import { FastAPIAIClient } from './ai-client.js'
import { WorkProBridge } from './bridge.js'

const logger = {
  info: (message, fields = {}) => console.info(message, fields),
  error: (message, fields = {}) => console.error(message, fields),
}

const token = process.env.WECHATY_PUPPET_SERVICE_TOKEN || ''
if (!token) {
  throw new Error('WECHATY_PUPPET_SERVICE_TOKEN is required')
}

const staffUserid = process.env.WORKPRO_STAFF_USERID || ''
if (!staffUserid) {
  throw new Error('WORKPRO_STAFF_USERID is required')
}

const bot = WechatyBuilder.build({
  name: process.env.WORKPRO_BRIDGE_NAME || 'workpro-wechaty-bridge',
  puppet: '@juzi/wechaty-puppet-service',
  puppetOptions: {
    token,
    authority: process.env.WECHATY_PUPPET_SERVICE_AUTHORITY || undefined,
  },
})

bot.on('scan', (qrcode, status) => {
  logger.info('scan qrcode to login', { status, qrcode })
})
bot.on('login', (user) => {
  logger.info('wechaty login success', { userId: user.id })
})
bot.on('logout', (user) => {
  logger.info('wechaty logout', { userId: user?.id ?? null })
})

const aiClient = new FastAPIAIClient({
  baseUrl: process.env.WORKPRO_BRIDGE_API_BASE_URL || 'http://app:8000',
  endpointPath: process.env.WORKPRO_BRIDGE_API_ENDPOINT || '/chat/messages',
  authToken: process.env.WORKPRO_BRIDGE_API_TOKEN || '',
  staffUserid,
  timeoutMs: Number(process.env.WORKPRO_BRIDGE_HTTP_TIMEOUT_MS || 10000),
})

const autoAcceptFriendship = (process.env.WORKPRO_AUTO_ACCEPT_FRIENDSHIP || 'false') === 'true'
const bridge = new WorkProBridge({
  bot,
  types,
  aiClient,
  logger,
  autoAcceptFriendship,
})

bridge.register()
await bot.start()
logger.info('workpro wechaty bridge started')
