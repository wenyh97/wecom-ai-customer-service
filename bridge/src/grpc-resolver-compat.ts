import { createRequire } from 'node:module'

import { Metadata, status } from '@grpc/grpc-js'
import { WechatyResolver, WechatyToken } from 'wechaty-token'

interface TcpSubchannelAddress {
  host: string
  port: number
}

interface Endpoint {
  addresses: TcpSubchannelAddress[]
}

interface WechatyResolverTarget {
  authority?: string
  path: string
  scheme?: string
}

interface ResolverListenerLike {
  onSuccessfulResolution: (
    endpointList: Endpoint[],
    serviceConfig: null,
    serviceConfigError: null,
    configSelector: null,
    attributes: Record<string, unknown>,
  ) => void
  onError: (error: {
    code: number
    details: string
    metadata: Metadata
  }) => void
}

interface WechatyResolverLike {
  target: WechatyResolverTarget
  listener: ResolverListenerLike
  addresses: TcpSubchannelAddress[]
  updateResolution: () => Promise<void>
}

const cjsRequire = createRequire(__filename)
const GRPC_ENDPOINT_COMPAT_APPLIED = Symbol.for('wecom-ai-customer-service.grpc-endpoint-compat-applied')

function formatResolverTarget (target: WechatyResolverTarget): string {
  const scheme = target.scheme ?? 'wechaty'
  const authority = target.authority ?? ''
  return `${scheme}://${authority}/${target.path}`
}

export function isValidGrpcTcpAddress (address: unknown): address is TcpSubchannelAddress {
  if (address == null || typeof address !== 'object') {
    return false
  }

  const candidate = address as Partial<TcpSubchannelAddress>
  return (
    typeof candidate.host === 'string' &&
    candidate.host.trim() !== '' &&
    Number.isInteger(candidate.port) &&
    candidate.port != null &&
    candidate.port > 0 &&
    candidate.port <= 65535
  )
}

export function wrapGrpcTcpAddressAsEndpoints (address: TcpSubchannelAddress): Endpoint[] {
  return [{
    addresses: [{
      host: address.host,
      port: address.port,
    }],
  }]
}

function reportResolutionError (
  listener: ResolverListenerLike,
  target: WechatyResolverTarget,
  reason: string,
): void {
  listener.onError({
    code: status.UNAVAILABLE,
    details: `Wechaty service discovery / resolution failed for target ${formatResolverTarget(target)}: ${reason}`,
    metadata: new Metadata(),
  })
}

export function applyWechatyGrpcEndpointCompat (): void {
  const resolverPrototype = WechatyResolver.prototype as unknown as WechatyResolverLike & {
    [GRPC_ENDPOINT_COMPAT_APPLIED]?: boolean
  }

  if (resolverPrototype[GRPC_ENDPOINT_COMPAT_APPLIED]) {
    return
  }

  resolverPrototype[GRPC_ENDPOINT_COMPAT_APPLIED] = true
  resolverPrototype.updateResolution = async function updateResolution (this: WechatyResolverLike): Promise<void> {
    let address: unknown

    try {
      address = await new WechatyToken({
        authority: this.target.authority,
        token: this.target.path,
      }).discover()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown resolution error')
      reportResolutionError(this.listener, this.target, message)
      return
    }

    if (!isValidGrpcTcpAddress(address)) {
      reportResolutionError(this.listener, this.target, 'service discovery returned an invalid TCP endpoint')
      return
    }

    this.addresses = [address]

    process.nextTick(() => {
      this.listener.onSuccessfulResolution(
        wrapGrpcTcpAddressAsEndpoints(address),
        null,
        null,
        null,
        {},
      )
    })
  }
}

applyWechatyGrpcEndpointCompat()
cjsRequire('@juzi/wechaty-puppet-service')
