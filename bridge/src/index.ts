import { createBridgeApplication, loadConfig } from './service'

async function main (): Promise<void> {
  const config = loadConfig(process.env)
  const app = createBridgeApplication(config)
  await app.start()
}

main().catch((error) => {
  console.error('[bridge] fatal startup error', {
    code: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
})
