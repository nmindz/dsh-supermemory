/**
 * The stdio MCP bridge, exercised end to end against a local stand-in for the
 * hosted Supermemory MCP server.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const PROXY = path.join(import.meta.dirname, '..', 'src', 'mcp-proxy.ts')

// A forced tag in the developer's shell would mask the derived one.
delete process.env.SUPERMEMORY_REPO_TAG
delete process.env.SUPERMEMORY_ISOLATE_WORKTREES

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

function startProxy(home: string, cwd?: string): ProxyRun {
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
      cwd,
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

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-proxy-repo-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  git('init', '-q')
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  return fs.realpathSync.native(dir)
}

/** Write each JSON-RPC line, give the proxy time to forward, then close stdin. */
async function drive(run: ProxyRun, messages: unknown[]): Promise<string[]> {
  for (const message of messages) run.child.stdin.write(`${JSON.stringify(message)}\n`)
  await new Promise(resolve => setTimeout(resolve, 600))
  run.child.stdin.end()
  return run.lines
}

/** Answer the request just recorded in `seen` with an empty success. */
function echoResult(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('content-type', 'application/json')
  const { id } = JSON.parse(seen.at(-1)!.body) as { id?: number }
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }))
}

function forwardedCalls(): { method: string; params?: { name?: string; arguments?: unknown } }[] {
  return seen.map(record => JSON.parse(record.body))
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

  test('injects the repo container tag when space-scoped tools omit it', async () => {
    seen = []
    respond = echoResult
    const repo = makeRepo()
    const home = homeWithKey('sm_test_key')
    const { getContainerTag } = await import('../src/lib/container-tag.ts')
    const expected = getContainerTag(repo)

    await drive(startProxy(home, repo), [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_memory', arguments: { query: 'auth' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_memory', arguments: { content: 'remember this' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listDocuments' } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_memories', arguments: '{"limit":5}' } },
    ])

    const forwarded = forwardedCalls()
    assert.match(expected, /^repo_widgets__[0-9a-f]{16}$/)
    assert.equal((forwarded[0]!.params!.arguments as Record<string, unknown>).containerTag, expected)
    assert.equal((forwarded[0]!.params!.arguments as Record<string, unknown>).query, 'auth')
    assert.equal((forwarded[1]!.params!.arguments as Record<string, unknown>).containerTag, expected)
    assert.deepEqual(forwarded[2]!.params!.arguments, { containerTag: expected })
    assert.deepEqual(
      JSON.parse(forwarded[3]!.params!.arguments as string),
      { limit: 5, containerTag: expected },
      'string-encoded arguments stay string-encoded',
    )
  })

  test('keeps an explicit containerTag and leaves unrelated tools alone', async () => {
    seen = []
    respond = echoResult
    const repo = makeRepo()
    const home = homeWithKey('sm_test_key')

    await drive(startProxy(home, repo), [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_memory', arguments: { query: 'auth', containerTag: 'other_space' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set-active-tag', arguments: { containerTag: 'picked' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'who_am_i' } },
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    ])

    const forwarded = forwardedCalls()
    assert.equal((forwarded[0]!.params!.arguments as Record<string, unknown>).containerTag, 'other_space')
    assert.equal((forwarded[1]!.params!.arguments as Record<string, unknown>).containerTag, 'picked')
    assert.equal(forwarded[2]!.params!.arguments, undefined)
    assert.equal(forwarded[3]!.method, 'tools/list')
    assert.equal(forwarded[3]!.params, undefined)
  })
})
