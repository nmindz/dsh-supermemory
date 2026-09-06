/**
 * The stdio MCP bridge, exercised end to end against a local stand-in for the
 * hosted Supermemory MCP server.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const PROXY = path.join(import.meta.dirname, '..', 'src', 'mcp-proxy.ts')

let server: http.Server
let origin: string
let seen: { auth?: string; session?: string; body: string }[] = []
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void

before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({
        auth: req.headers.authorization,
        session: req.headers['mcp-session-id'] as string | undefined,
        body,
      })
      respond(req, res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  origin = `http://127.0.0.1:${address.port}/mcp`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

interface ProxyRun {
  child: ChildProcessWithoutNullStreams
  lines: Promise<string[]>
}

function startProxy(home: string): ProxyRun {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', PROXY],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_MCP_URL: origin,
        SUPERMEMORY_CC_API_KEY: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams

  const lines = new Promise<string[]>((resolve) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.on('close', () => resolve(out.split('\n').filter(Boolean)))
  })

  return { child, lines }
}

function homeWithKey(apiKey: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-proxy-'))
  if (apiKey) {
    const dir = path.join(home, '.supermemory-claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ apiKey }))
  }
  return home
}

describe('statusline entry point', () => {
  test('renders when invoked from a path containing spaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh sm space-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-sl-'))
    const script = path.join(dir, 'statusline.mts')
    fs.copyFileSync(path.join(import.meta.dirname, '..', 'src', 'statusline.ts'), script)

    // Seed one ready context so the renderer has something to print.
    const stateDir = path.join(
      home,
      '.supermemory-claude',
      'statusline',
      'statusline-state',
      createHash('sha256').update('session-space').digest('hex'),
    )
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, 'context.json'),
      JSON.stringify({ version: 1, event: 'context', updatedAt: Date.now(), status: 'ready', memoryItemsLoaded: 2 }),
    )

    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', script],
      { env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    const out = await new Promise<string>((resolve) => {
      let text = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { text += chunk })
      child.on('close', () => resolve(text))
      child.stdin.write(`${JSON.stringify({ session_id: 'session-space' })}\n`)
      child.stdin.end()
    })

    // The renderer always colors; strip ANSI before asserting on the words.
    const plain = out.replace(/\u001b\[[0-9;]*m/g, '')
    assert.match(plain, /supermemory/, 'a spaced, symlinked install path must still render')
    assert.match(plain, /2 loaded/)
  })
})

describe('mcp proxy', () => {
  test('forwards requests with the stored key and tracks the MCP session', async () => {
    seen = []
    respond = (_req, res) => {
      res.setHeader('mcp-session-id', 'session-xyz')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
    }

    const { child, lines } = startProxy(homeWithKey('sm_test_key'))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    await new Promise(resolve => setTimeout(resolve, 400))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    await new Promise(resolve => setTimeout(resolve, 400))
    child.stdin.end()

    const out = await lines
    assert.equal(seen.length, 2)
    assert.equal(seen[0]!.auth, 'Bearer sm_test_key', 'the stored credential must authenticate the call')
    assert.equal(seen[0]!.session, undefined, 'no session id exists before the first response')
    assert.equal(seen[1]!.session, 'session-xyz', 'the returned session id must be echoed back')
    assert.equal(JSON.parse(out[0]!).result.tools.length, 0)
  })

  test('unwraps SSE responses into stdout lines', async () => {
    seen = []
    respond = (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n')
    }

    const { child, lines } = startProxy(homeWithKey('sm_test_key'))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`)
    await new Promise(resolve => setTimeout(resolve, 500))
    child.stdin.end()

    const out = await lines
    assert.equal(out.length, 1, 'exactly the data payload reaches stdout')
    assert.deepEqual(JSON.parse(out[0]!), { jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  test('answers with a clear JSON-RPC error when unauthenticated', async () => {
    seen = []
    respond = (_req, res) => { res.end('{}') }

    const { child, lines } = startProxy(homeWithKey(null))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`)
    await new Promise(resolve => setTimeout(resolve, 400))
    child.stdin.end()

    const out = await lines
    assert.equal(seen.length, 0, 'an unauthenticated proxy must not reach the network')
    const message = JSON.parse(out[0]!)
    assert.equal(message.error.code, -32001)
    assert.match(message.error.message, /not authenticated/)
    assert.match(message.error.message, /SUPERMEMORY_CC_API_KEY/)
  })

  test('surfaces an upstream failure as a JSON-RPC error', async () => {
    seen = []
    respond = (_req, res) => {
      res.statusCode = 401
      res.end('revoked')
    }

    const { child, lines } = startProxy(homeWithKey('sm_test_key'))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' })}\n`)
    await new Promise(resolve => setTimeout(resolve, 400))
    child.stdin.end()

    const out = await lines
    const message = JSON.parse(out[0]!)
    assert.equal(message.error.code, -32000)
    assert.match(message.error.message, /Supermemory MCP 401: revoked/)
  })
})
