import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkProBridge } from '../src/bridge.js'

const TYPES = {
  Friendship: {
    Receive: 2,
    Confirm: 1,
  },
  Message: {
    Text: 7,
  },
}

function createHarness({ autoAcceptFriendship = false } = {}) {
  const bot = new EventEmitter()
  const calls = { ai: 0 }
  const logs = []
  const aiClient = {
    async generateReply() {
      calls.ai += 1
      return 'ok'
    },
  }
  const logger = {
    info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
    error: (msg, fields) => logs.push({ level: 'error', msg, fields }),
  }

  const bridge = new WorkProBridge({
    bot,
    types: TYPES,
    aiClient,
    logger,
    autoAcceptFriendship,
  })
  bridge.register()
  return { bot, calls, logs }
}

async function flushEvents() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('friendship默认不自动接受', async () => {
  const { bot } = createHarness()
  let accepted = 0
  bot.emit('friendship', {
    type: () => TYPES.Friendship.Receive,
    accept: async () => {
      accepted += 1
    },
  })

  await flushEvents()
  assert.equal(accepted, 0)
})

test('friendship显式开启后才接受', async () => {
  const { bot } = createHarness({ autoAcceptFriendship: true })
  let accepted = 0
  bot.emit('friendship', {
    type: () => TYPES.Friendship.Receive,
    accept: async () => {
      accepted += 1
    },
  })

  await flushEvents()
  assert.equal(accepted, 1)
})

test('非Receive类型不接受', async () => {
  const { bot } = createHarness({ autoAcceptFriendship: true })
  let accepted = 0
  bot.emit('friendship', {
    type: () => TYPES.Friendship.Confirm,
    accept: async () => {
      accepted += 1
    },
  })

  await flushEvents()
  assert.equal(accepted, 0)
})

test('room-join仅审计不发消息', async () => {
  const { bot, calls } = createHarness()
  bot.emit('room-join', { id: 'room-1' }, [{ id: 'a' }])

  await flushEvents()
  assert.equal(calls.ai, 0)
})

test('群消息不调用AI', async () => {
  const { bot, calls } = createHarness()
  bot.emit('message', {
    id: 'msg-1',
    self: () => false,
    room: () => ({ id: 'room-1' }),
    type: () => TYPES.Message.Text,
    talker: () => ({ id: 'talker-1' }),
    text: () => 'hello',
    say: async () => {},
  })

  await flushEvents()
  assert.equal(calls.ai, 0)
})

test('重复消息ID只处理一次', async () => {
  const { bot, calls } = createHarness()
  const message = {
    id: 'msg-dup-1',
    self: () => false,
    room: () => null,
    type: () => TYPES.Message.Text,
    talker: () => ({ id: 'talker-1' }),
    text: () => 'hello',
    say: async () => {},
  }
  bot.emit('message', message)
  bot.emit('message', message)

  await flushEvents()
  assert.equal(calls.ai, 1)
})

test('同一talker消息串行处理', async () => {
  const bot = new EventEmitter()
  const events = []
  let step = 0
  const aiClient = {
    async generateReply() {
      const current = ++step
      events.push(`start-${current}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      events.push(`end-${current}`)
      return `reply-${current}`
    },
  }
  const logger = { info: () => {}, error: () => {} }
  const bridge = new WorkProBridge({
    bot,
    types: TYPES,
    aiClient,
    logger,
  })
  bridge.register()

  const makeMessage = (id) => ({
    id,
    self: () => false,
    room: () => null,
    type: () => TYPES.Message.Text,
    talker: () => ({ id: 'talker-serial-1' }),
    text: () => `message-${id}`,
    say: async () => {},
  })

  bot.emit('message', makeMessage('msg-serial-1'))
  bot.emit('message', makeMessage('msg-serial-2'))
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2'])
})

test('error日志会脱敏', async () => {
  const { bot, logs } = createHarness()
  bot.emit('error', new Error('request failed with token=abc123xyz ******'))

  await flushEvents()

  const errorLog = logs.find((item) => item.level === 'error')
  assert.ok(errorLog)
  assert.equal(errorLog.msg, 'wechaty error event')
  assert.match(errorLog.fields.message, /\[REDACTED\]/)
  assert.doesNotMatch(errorLog.fields.message, /abc123xyz|hunter2/)
})
