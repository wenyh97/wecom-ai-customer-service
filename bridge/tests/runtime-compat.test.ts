import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const bridgeRoot = join(__dirname, '..')

describe('bridge runtime compatibility', () => {
  it('pins Node runtime to supported LTS image', () => {
    const dockerfile = readFileSync(join(bridgeRoot, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('FROM node:22-bookworm-slim')
  })

  it('keeps grpc-js resolver listener API compatible with wechaty-token', () => {
    const lockfile = JSON.parse(readFileSync(join(bridgeRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    expect(lockfile.packages['node_modules/@grpc/grpc-js']?.version).toBe('1.13.4')

    const grpcResolverDts = readFileSync(join(bridgeRoot, 'node_modules/@grpc/grpc-js/build/src/resolver.d.ts'), 'utf8')
    const wechatyResolver = readFileSync(join(bridgeRoot, 'node_modules/wechaty-token/dist/cjs/src/resolver-wechaty.js'), 'utf8')

    expect(wechatyResolver).toContain('this.listener.onSuccessfulResolution')
    expect(grpcResolverDts).toContain('onSuccessfulResolution(')
  })
})
