import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const children = []
let stopping = false
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const demo = args.includes('--demo')
const noInstall = args.includes('--no-install')
const portFlag = args.indexOf('--port')
const requested = portFlag >= 0 ? args[portFlag + 1] : process.env.PORT || '5173'
const initialPort = Number(requested)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    '用法：./start.sh [--demo] [--port 5173] [--no-install]\n默认浏览本机 Claude 历史；--demo 使用独立演示数据。端口占用时自动顺延。Ctrl+C 停止本次启动的服务。'
  )
  process.exit(0)
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    i++
    continue
  }
  if (!['--demo', '--no-install'].includes(args[i])) throw new Error(`未知选项：${args[i]}`)
}
if (!/^\d+$/.test(requested || '') || initialPort < 1 || initialPort > 65535)
  throw new Error('端口应为 1–65535 的整数。')

function stopChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}
async function stop(code) {
  if (stopping) return
  stopping = true
  children.forEach((child) => stopChild(child, 'SIGTERM'))
  for (
    let i = 0;
    i < 30 && children.some((child) => child.exitCode === null && child.signalCode === null);
    i++
  )
    await pause(100)
  children.forEach((child) => stopChild(child, 'SIGKILL'))
  process.exit(code)
}
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

async function pnpm(arguments_) {
  if (stopping) throw new Error('启动已取消。')
  const command = process.env.npm_execpath
  if (!command) throw new Error('请通过 ./start.sh 或 pnpm start:editor 启动。')
  // npm_execpath may point to a native @pnpm/exe binary, not a JavaScript file.
  const isScript = /\.[cm]?js$/i.test(command)
  const child = spawn(
    isScript ? process.execPath : command,
    isScript ? [command, ...arguments_] : arguments_,
    { cwd: root, stdio: 'inherit', detached: true }
  )
  children.push(child)
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`pnpm ${arguments_.join(' ')} 失败`))
    )
  })
}
async function availablePort(start) {
  for (let port = start; port <= 65535; port++) {
    const free = await new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', (error) =>
        error.code === 'EADDRINUSE' || error.code === 'EACCES' ? resolve(false) : reject(error)
      )
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('未找到可用端口。')
}

function demoEnvironment() {
  const home = path.join(root, '.editor-test/demo-home')
  const sessions = path.join(home, '.claude/projects')
  const project = '-demo-project'
  const session = '11111111-1111-4111-8111-111111111111'
  const folder = path.join(sessions, project)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = path.join(folder, `${session}.jsonl`)
  if (!existsSync(file)) {
    const common = { sessionId: session, cwd: '/demo/project', timestamp: new Date().toISOString() }
    const records = [
      { type: 'custom-title', customTitle: '演示：按内容块编辑历史消息', sessionId: session },
      {
        ...common,
        type: 'user',
        uuid: 'demo-user',
        parentUuid: null,
        message: { role: 'user', content: '请把标题改成蓝色，保留其他内容。' },
      },
      {
        ...common,
        type: 'assistant',
        uuid: 'demo-assistant',
        parentUuid: 'demo-user',
        message: {
          role: 'assistant',
          model: 'demo-model',
          usage: { input_tokens: 120, output_tokens: 80 },
          content: [
            {
              type: 'thinking',
              thinking: '先检查主题配置，再只修改标题样式。',
              signature: 'demo-signature',
            },
            { type: 'text', text: '我会保留已有布局，只调整标题颜色。' },
            { type: 'tool_use', id: 'demo-tool', name: 'Read', input: { file_path: 'theme.ts' } },
            {
              type: 'text',
              text: '标题已设置为蓝色。\n\n你可以只编辑这一块，其他正文、工具和后续消息都会保留。',
            },
          ],
        },
      },
      {
        ...common,
        type: 'user',
        uuid: 'demo-tool-result',
        parentUuid: 'demo-assistant',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'demo-tool',
              content: [{ type: 'text', text: 'heading.color = blue' }],
              is_error: false,
            },
          ],
        },
      },
      {
        ...common,
        type: 'user',
        uuid: 'demo-later',
        parentUuid: 'demo-tool-result',
        message: { role: 'user', content: '这是后续消息：编辑前面的内容时，请保留我。' },
      },
    ]
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', {
      mode: 0o600,
    })
  }
  return {
    env: { HOME: home, USERPROFILE: home, CLAUDE_SESSIONS_DIR: sessions },
    route: `/session/${project}/${session}`,
  }
}

async function main() {
  console.log(`Claude Code Chat History Editor · Node ${process.version}`)
  const vite = path.join(root, 'packages/web/node_modules/vite/bin/vite.js')
  if (
    !existsSync(vite) ||
    !existsSync(path.join(root, 'packages/core/node_modules/jsonc-parser'))
  ) {
    if (noInstall)
      throw new Error('依赖不完整，请先运行 pnpm install --frozen-lockfile --ignore-scripts。')
    await pnpm(['install', '--frozen-lockfile', '--ignore-scripts'])
  }
  await pnpm(['build:core'])
  const environment = demo ? demoEnvironment() : { env: {}, route: '/' }
  if (demo) console.log('演示模式：仅使用 .editor-test/demo-home 中的合成会话。')
  for (let attempt = 0, nextPort = initialPort; attempt < 5; attempt++) {
    const port = await availablePort(nextPort)
    if (port !== initialPort) console.log(`端口 ${initialPort} 已占用，改用 ${port}。`)
    if (stopping) return
    const child = spawn(
      process.execPath,
      [vite, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: path.join(root, 'packages/web'),
        env: {
          ...process.env,
          ...environment.env,
          BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT || '10M',
        },
        stdio: 'inherit',
        detached: true,
      }
    )
    children.push(child)
    child.once('error', (error) => {
      console.error(error.message)
      void stop(1)
    })
    const url = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 120 && child.exitCode === null && child.signalCode === null; i++) {
      try {
        ready = (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok
      } catch {
        /* Wait for Vite. */
      }
      if (ready) break
      await pause(250)
    }
    if (child.exitCode !== null) {
      nextPort = port + 1
      continue
    }
    if (!ready) throw new Error('服务未能就绪，请检查上方日志。')
    child.once('exit', (code) => {
      if (!stopping) {
        console.error('Web 服务已退出。')
        void stop(code || 1)
      }
    })
    console.log(`\n启动成功：${url}${environment.route}\n保持此终端运行，Ctrl+C 退出。\n`)
    return
  }
  throw new Error('服务连续启动失败，请检查依赖和端口。')
}
main().catch((error) => {
  if (!stopping) {
    console.error(error.message)
    void stop(1)
  }
})
