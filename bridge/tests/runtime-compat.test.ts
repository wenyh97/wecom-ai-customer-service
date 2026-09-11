import { describe, expect, it, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { status } from '@grpc/grpc-js'
import { WechatyResolver, WechatyToken } from 'wechaty-token'

import { applyWechatyGrpcEndpointCompat } from '../src/grpc-resolver-compat'

const bridgeRoot = join(__dirname, '..')
const grpcInternalRoot = join(bridgeRoot, 'node_modules', '@grpc', 'grpc-js', 'build', 'src')
const cjsRequire = createRequire(__filename)
const { PickFirstLoadBalancer, PickFirstLoadBalancingConfig } = cjsRequire(join(grpcInternalRoot, 'load-balancer-pick-first.js')) as {
  PickFirstLoadBalancer: new (channelControlHelper: Record<string, unknown>) => {
    updateAddressList: (endpointList: unknown[], lbConfig: object, options: Record<string, unknown>) => void
    connectToAddressList?: (addressList: unknown[], options: Record<string, unknown>) => void
  }
  PickFirstLoadBalancingConfig: new (shuffleAddressList: boolean) => object
}
const { parseUri } = cjsRequire(join(grpcInternalRoot, 'uri-parser.js')) as {
  parseUri: (target: string) => { authority?: string, path: string, scheme?: string }
}

function createProbePickFirstLoadBalancer (): {
  capturedAddresses: Array<{ host: string, port: number }>
  loadBalancer: {
    updateAddressList: (endpointList: unknown[], lbConfig: object, options: Record<string, unknown>) => void
    connectToAddressList?: (addressList: Array<{ host: string, port: number }>, options: Record<string, unknown>) => void
  }
} {
  const capturedAddresses: Array<{ host: string, port: number }> = []
  const loadBalancer = new PickFirstLoadBalancer({
    createSubchannel: () => {
      throw new Error('unexpected subchannel creation in resolver compatibility test')
    },
    updateState: () => {},
    requestReresolution: () => {},
    addChannelzChild: () => {},
    removeChannelzChild: () => {},
  })
  loadBalancer.connectToAddressList = (addressList) => {
    capturedAddresses.push(...(addressList as Array<{ host: string, port: number }>))
  }
  return { capturedAddresses, loadBalancer }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bridge runtime compatibility', () => {
  it('pins Node runtime to supported LTS image', () => {
    const dockerfile = readFileSync(join(bridgeRoot, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('FROM node:22-bookworm-slim')
  })

  it('keeps grpc-js 1.13.5 pinned for the audited resolver compatibility target', () => {
    const lockfile = JSON.parse(readFileSync(join(bridgeRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    expect(lockfile.packages['node_modules/@grpc/grpc-js']?.version).toBe('1.13.5')
  })

  it('documents that the old raw address list shape crashes the real pick-first balancer', () => {
    const { loadBalancer } = createProbePickFirstLoadBalancer()

    expect(() => {
      loadBalancer.updateAddressList(
        [{ host: '127.0.0.1', port: 8788 }],
        new PickFirstLoadBalancingConfig(false),
        {},
      )
    }).toThrow(/Cannot use 'in' operator to search for 'port' in undefined/)
  })

  it('wraps discovered tcp endpoints before entering the real grpc-js balancer path', async () => {
    applyWechatyGrpcEndpointCompat()
    const discoverSpy = vi.spyOn(WechatyToken.prototype, 'discover').mockResolvedValue({
      host: '127.0.0.1',
      port: 8788,
    })
    const { capturedAddresses, loadBalancer } = createProbePickFirstLoadBalancer()
    let thrownMessage: string | undefined
    let callbackArgumentCount = 0
    let receivedEndpointList: unknown[] | undefined
    let receivedAttributes: Record<string, unknown> | undefined

    const resolutionCompleted = new Promise<void>((resolve, reject) => {
      const resolver = new WechatyResolver(
        parseUri('wechaty://token-service-discovery-test.juzibot.com/test-token'),
        {
          onSuccessfulResolution (endpointList, serviceConfig, serviceConfigError, configSelector, attributes) {
            callbackArgumentCount = arguments.length
            receivedEndpointList = endpointList as unknown[]
            receivedAttributes = attributes as Record<string, unknown>
            try {
              expect(serviceConfig).toBeNull()
              expect(serviceConfigError).toBeNull()
              expect(configSelector).toBeNull()
              loadBalancer.updateAddressList(
                endpointList as unknown[],
                new PickFirstLoadBalancingConfig(false),
                attributes as Record<string, unknown>,
              )
              resolve()
            } catch (error) {
              thrownMessage = error instanceof Error ? error.message : String(error)
              reject(error)
            }
          },
          onError (error) {
            reject(new Error(`unexpected resolver error: ${error.details}`))
          },
        },
        {},
      )
      void resolver.updateResolution()
    })

    await resolutionCompleted

    expect(discoverSpy).toHaveBeenCalledOnce()
    expect(callbackArgumentCount).toBe(5)
    expect(thrownMessage).toBeUndefined()
    expect(thrownMessage?.includes('ERR_INVALID_ARG_TYPE') ?? false).toBe(false)
    expect(thrownMessage?.includes("Cannot use 'in' operator to search for 'port' in undefined") ?? false).toBe(false)
    expect(receivedAttributes).toEqual({})
    expect(receivedEndpointList).toEqual([{
      addresses: [{
        host: '127.0.0.1',
        port: 8788,
      }],
    }])
    expect(capturedAddresses).toEqual([{
      host: '127.0.0.1',
      port: 8788,
    }])
  })

  it('reports invalid discovered addresses through onError instead of crashing the balancer', async () => {
    applyWechatyGrpcEndpointCompat()
    const discoverSpy = vi.spyOn(WechatyToken.prototype, 'discover').mockResolvedValue({
      host: '',
      port: 8788,
    })
    const onSuccessfulResolution = vi.fn()
    const onError = vi.fn()
    const resolver = new WechatyResolver(
      parseUri('wechaty://token-service-discovery-test.juzibot.com/test-token'),
      {
        onSuccessfulResolution,
        onError,
      },
      {},
    )

    await resolver.updateResolution()
    await new Promise((resolve) => setImmediate(resolve))

    expect(discoverSpy).toHaveBeenCalledOnce()
    expect(onSuccessfulResolution).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: status.UNAVAILABLE,
    })
    expect(onError.mock.calls[0]?.[0]?.details).toContain('invalid TCP endpoint')
  })
})
