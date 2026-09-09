import { sanitizeError } from './logging.js'

function maskIdentifier(value) {
  if (!value) return null
  if (value.length <= 6) return '***'
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

export class WorkProBridge {
  constructor({ bot, types, aiClient, logger, autoAcceptFriendship = false }) {
    this.bot = bot
    this.types = types
    this.aiClient = aiClient
    this.logger = logger
    this.autoAcceptFriendship = autoAcceptFriendship
    this.processedMessageIds = new Set()
    this.queueByTalker = new Map()
  }

  register() {
    this.bot.on('error', (error) => {
      this.logger.error('wechaty error event', sanitizeError(error))
    })

    this.bot.on('friendship', async (friendship) => {
      const friendshipType = friendship.type()
      if (friendshipType !== this.types.Friendship.Receive) {
        this.logger.info('friendship ignored because type is not receive', { friendshipType })
        return
      }
      if (!this.autoAcceptFriendship) {
        this.logger.info('friendship receive observed, auto-accept disabled')
        return
      }

      try {
        await friendship.accept()
        this.logger.info('friendship accepted by explicit config')
      } catch (error) {
        this.logger.error('failed to accept friendship', sanitizeError(error))
      }
    })

    this.bot.on('room-join', (room, inviteeList) => {
      this.logger.info('room-join observed', {
        roomId: maskIdentifier(room?.id),
        inviteeCount: Array.isArray(inviteeList) ? inviteeList.length : 0,
      })
    })

    this.bot.on('message', (message) => {
      const talkerId = message.talker()?.id
      const queueKey = talkerId || '__unknown__'
      const chain = this.queueByTalker.get(queueKey) ?? Promise.resolve()
      const next = chain
        .then(async () => this.handleMessage(message))
        .catch((error) => {
          this.logger.error('message handling failed', sanitizeError(error))
        })
        .finally(() => {
          if (this.queueByTalker.get(queueKey) === next) {
            this.queueByTalker.delete(queueKey)
          }
        })
      this.queueByTalker.set(queueKey, next)
    })
  }

  async handleMessage(message) {
    if (message.self()) return
    if (message.room()) {
      this.logger.info('group message ignored')
      return
    }
    if (message.type() !== this.types.Message.Text) return

    const talkerId = message.talker()?.id
    const messageId = message.id
    if (!talkerId || !messageId || this.processedMessageIds.has(messageId)) {
      return
    }
    this.processedMessageIds.add(messageId)

    const text = message.text()?.trim()
    if (!text) {
      return
    }

    const reply = await this.aiClient.generateReply({
      conversationId: talkerId,
      messageId,
      content: text,
    })

    if (reply) {
      await message.say(reply)
    }
  }
}
