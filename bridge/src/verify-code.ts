import { promisify } from 'node:util'

import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'
import type { Wechaty } from '@juzi/wechaty'

interface VerifyCodeRequest {
  setId: (value: string) => void
  setCode: (value: string) => void
}

interface CancelVerifyCodeRequest {
  setId: (value: string) => void
}

interface VerifyCodeGrpcClient {
  enterVerifyCode?: (request: VerifyCodeRequest, callback: (error: Error | null) => void) => void
  cancelVerifyCode?: (request: CancelVerifyCodeRequest, callback: (error: Error | null) => void) => void
}

interface VerifyCodePuppetLike {
  grpcManager?: {
    client?: VerifyCodeGrpcClient
  }
  enterVerifyCode?: (id: string, code: string) => Promise<void>
  cancelVerifyCode?: (id: string) => Promise<void>
}

interface VerifyCodeBotLike {
  puppet?: VerifyCodePuppetLike
  enterVerifyCode?: (id: string, code: string) => Promise<void>
  cancelVerifyCode?: (id: string) => Promise<void>
}

export interface VerifyCodeSubmitter {
  mode: 'grpc-client' | 'wechaty-bot' | 'puppet'
  submit: (id: string, code: string) => Promise<void>
  cancel: (id: string) => Promise<void>
}

function resolveBotTarget (bot: Wechaty): {
  candidate: VerifyCodeBotLike
  puppet: VerifyCodePuppetLike | undefined
  grpcClient: VerifyCodeGrpcClient | undefined
} {
  const candidate = bot as VerifyCodeBotLike
  let puppet: VerifyCodePuppetLike | undefined
  try {
    puppet = candidate.puppet
  } catch {
    puppet = undefined
  }
  const grpcClient = puppet?.grpcManager?.client
  return { candidate, puppet, grpcClient }
}

function resolveMode (bot: Wechaty): VerifyCodeSubmitter['mode'] | null {
  const target = resolveBotTarget(bot)
  if (typeof target.grpcClient?.enterVerifyCode === 'function' && typeof target.grpcClient?.cancelVerifyCode === 'function') {
    return 'grpc-client'
  }
  if (typeof target.candidate.enterVerifyCode === 'function' && typeof target.candidate.cancelVerifyCode === 'function') {
    return 'wechaty-bot'
  }
  if (typeof target.puppet?.enterVerifyCode === 'function' && typeof target.puppet.cancelVerifyCode === 'function') {
    return 'puppet'
  }
  return null
}

export function createVerifyCodeSubmitter (bot: Wechaty): VerifyCodeSubmitter {
  const mode = resolveMode(bot)

  if (mode === 'grpc-client') {
    return {
      mode: 'grpc-client',
      submit: async (id, code) => {
        const { grpcClient } = resolveBotTarget(bot)
        if (typeof grpcClient?.enterVerifyCode !== 'function') {
          throw new Error('verify-code grpc client is unavailable')
        }
        const request = new grpcPuppet.EnterVerifyCodeRequest()
        request.setId(id)
        request.setCode(code)
        await promisify(grpcClient.enterVerifyCode.bind(grpcClient))(request)
      },
      cancel: async (id) => {
        const { grpcClient } = resolveBotTarget(bot)
        if (typeof grpcClient?.cancelVerifyCode !== 'function') {
          throw new Error('verify-code grpc client is unavailable')
        }
        const request = new grpcPuppet.CancelVerifyCodeRequest()
        request.setId(id)
        await promisify(grpcClient.cancelVerifyCode.bind(grpcClient))(request)
      },
    }
  }

  if (mode === 'wechaty-bot') {
    return {
      mode: 'wechaty-bot',
      submit: async (id, code) => {
        const currentMode = resolveMode(bot)
        if (currentMode === 'grpc-client') {
          const { grpcClient } = resolveBotTarget(bot)
          if (typeof grpcClient?.enterVerifyCode !== 'function') {
            throw new Error('verify-code grpc client is unavailable')
          }
          const request = new grpcPuppet.EnterVerifyCodeRequest()
          request.setId(id)
          request.setCode(code)
          await promisify(grpcClient.enterVerifyCode.bind(grpcClient))(request)
          return
        }
        const { candidate } = resolveBotTarget(bot)
        if (typeof candidate.enterVerifyCode !== 'function') {
          throw new Error('verify-code submission is unavailable')
        }
        await candidate.enterVerifyCode(id, code)
      },
      cancel: async (id) => {
        const currentMode = resolveMode(bot)
        if (currentMode === 'grpc-client') {
          const { grpcClient } = resolveBotTarget(bot)
          if (typeof grpcClient?.cancelVerifyCode !== 'function') {
            throw new Error('verify-code grpc client is unavailable')
          }
          const request = new grpcPuppet.CancelVerifyCodeRequest()
          request.setId(id)
          await promisify(grpcClient.cancelVerifyCode.bind(grpcClient))(request)
          return
        }
        const { candidate } = resolveBotTarget(bot)
        if (typeof candidate.cancelVerifyCode !== 'function') {
          throw new Error('verify-code cancellation is unavailable')
        }
        await candidate.cancelVerifyCode(id)
      },
    }
  }

  if (mode === 'puppet') {
    return {
      mode: 'puppet',
      submit: async (id, code) => {
        const currentMode = resolveMode(bot)
        if (currentMode === 'grpc-client') {
          const { grpcClient } = resolveBotTarget(bot)
          if (typeof grpcClient?.enterVerifyCode !== 'function') {
            throw new Error('verify-code grpc client is unavailable')
          }
          const request = new grpcPuppet.EnterVerifyCodeRequest()
          request.setId(id)
          request.setCode(code)
          await promisify(grpcClient.enterVerifyCode.bind(grpcClient))(request)
          return
        }
        const { puppet } = resolveBotTarget(bot)
        if (typeof puppet?.enterVerifyCode !== 'function') {
          throw new Error('verify-code puppet method is unavailable')
        }
        await puppet.enterVerifyCode(id, code)
      },
      cancel: async (id) => {
        const currentMode = resolveMode(bot)
        if (currentMode === 'grpc-client') {
          const { grpcClient } = resolveBotTarget(bot)
          if (typeof grpcClient?.cancelVerifyCode !== 'function') {
            throw new Error('verify-code grpc client is unavailable')
          }
          const request = new grpcPuppet.CancelVerifyCodeRequest()
          request.setId(id)
          await promisify(grpcClient.cancelVerifyCode.bind(grpcClient))(request)
          return
        }
        const { puppet } = resolveBotTarget(bot)
        if (typeof puppet?.cancelVerifyCode !== 'function') {
          throw new Error('verify-code puppet cancel method is unavailable')
        }
        await puppet.cancelVerifyCode(id)
      },
    }
  }

  throw new Error('verify-code submission is not supported by the current Wechaty runtime')
}
