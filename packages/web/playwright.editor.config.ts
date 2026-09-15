import { defineConfig, devices } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const temporaryRoot = path.resolve(here, '../../.editor-test')
mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })
const home = process.env.CLAUDE_EDITOR_TEST_HOME || mkdtempSync(path.join(temporaryRoot, 'e2e-'))
if (!path.resolve(home).startsWith(temporaryRoot + path.sep))
  throw new Error('Editor tests require an isolated home under .editor-test')
process.env.CLAUDE_EDITOR_TEST_HOME = home
mkdirSync(path.join(home, '.claude/projects'), { recursive: true })

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
const port = process.env.CLAUDE_EDITOR_TEST_PORT || String(await freePort())
process.env.CLAUDE_EDITOR_TEST_PORT = port
const production = process.env.EDITOR_TEST_PRODUCTION === '1'

export default defineConfig({
  testDir: './editor-e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30000,
  reporter: 'list',
  outputDir: path.join(home, 'results'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command: production
      ? `${JSON.stringify(process.execPath)} build/index.js`
      : `${JSON.stringify(process.execPath)} node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port ${port} --strictPort`,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_STATE_HOME: path.join(home, 'state'),
      CLAUDE_SESSIONS_DIR: path.join(home, '.claude/projects'),
      BODY_SIZE_LIMIT: '10M',
      PORT: port,
      HOST: '127.0.0.1',
      ORIGIN: `http://127.0.0.1:${port}`,
    },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
