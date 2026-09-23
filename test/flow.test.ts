/**
 * The recall, tool-gate, and index listeners driven end to end through a fake
 * Cordis context, against a local stand-in for the Supermemory API.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-flow-'))
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.SUPERMEMORY_CC_API_KEY = 'sm_test_key'
delete process.env.SUPERMEMORY_REPO_TAG
delete process.env.SUPERMEMORY_ISOLATE_WORKTREES
process.env.NO_COLOR = '1'

const { createRuntime } = await import('../src/runtime.ts')
const { registerRecall, isTimeout } = await import('../src/recall.ts')
const { registerApprove } = await import('../src/approve.ts')
const { registerCodebaseIndex } = await import('../src/codebase-index.ts')
const { getContainerTag } = await import('../src/lib/container-tag.ts')

type Listener = (...args: any[]) => any

let server: http.Server
let respond: (res: http.ServerResponse) => void = res => res.end('{}')

before(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => respond(res))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.SUPERMEMORY_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(HOME, { recursive: true, force: true })
})

function json(body: unknown): (res: http.ServerResponse) => void {
  return (res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
}

function fakeCtx() {
  const listeners = new Map<string, Listener[]>()
  const logs: string[] = []
  const skills: Record<string, unknown>[] = []
  const ctx = {
    on(name: string, fn: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
      return () => {}
    },
    logger: () => ({ info: (text: string) => logs.push(text), warn: (text: string) => logs.push(text) }),
    inject(_deps: string[], fn: (inner: unknown) => void) {
      fn({ skills: { register: (skill: Record<string, unknown>) => skills.push(skill) } })
    },
  }
  const listener = (name: string): Listener => {
    const found = listeners.get(name)?.[0]
    assert.ok(found, `${name} listener registered`)
    return found
  }
  return { ctx: ctx as never, listener, logs, skills }
}

function makeRepo(remote: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-flow-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  return fs.realpathSync.native(dir)
}

const agentIn = (cwd: string, id: string) => ({ id, session: { header: { id, cwd } } })
const prompt = (text: string) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const enter = (messages: unknown[]) => async () => ({ kind: 'enter', messages: [...messages] })
const textOf = (message: { content: { text: string }[] }) => message.content.map(block => block.text).join('')

const RECALL_CONFIG = { injectProfile: false, recall: true, autoApprove: true, mcpServerName: 'supermemory' }

describe('recall discovery', () => {
  test('advertises the search tool once per session when the container is empty', async () => {
    respond = json({ searchResults: { results: [] } })
    const repo = makeRepo('git@github.com:acme/empty.git')
    const { ctx, listener, logs } = fakeCtx()
    registerRecall(ctx, createRuntime(ctx, repo), RECALL_CONFIG)
    const preStep = listener('agent/pre-step')
    const agent = agentIn(repo, 'discovery-a')
    const messages = [prompt('what did we decide about the auth flow?')]

    const first = await preStep({ agent, messages }, enter(messages))
    assert.equal(first.messages.length, 2)
    const injected = first.messages[1]
    assert.deepEqual(injected.source, { kind: 'supermemory', form: 'recall' })
    const text = textOf(injected)
    assert.match(text, /^<supermemory-recall>\nNo stored memories matched this prompt/)
    assert.match(text, /exposed here as mcp__supermemory__search_memory/)
    assert.match(text, new RegExp(`containerTag: "${getContainerTag(repo)}"`))
    assert.match(text, /Omitting containerTag also lands here/)
    assert.match(text, /auto-approved/)
    assert.doesNotMatch(text, /ToolSearch/, 'DSH has no tool search to point at')
    assert.ok(logs.some(line => line.includes('no memories yet for this project')))

    const second = await preStep({ agent, messages }, enter(messages))
    assert.equal(second.messages.length, 1, 'the notice fires once per session')
  })

  test('tells a session on a differently scoped proxy to always pass the tag', async () => {
    respond = json({ searchResults: { results: [] } })
    const repo = makeRepo('git@github.com:acme/scoped.git')
    const elsewhere = makeRepo('git@github.com:acme/host-cwd.git')
    const { ctx, listener } = fakeCtx()
    registerRecall(ctx, createRuntime(ctx, elsewhere), RECALL_CONFIG)
    const messages = [prompt('what did we decide about the auth flow?')]

    const out = await listener('agent/pre-step')({ agent: agentIn(repo, 'discovery-b'), messages }, enter(messages))
    const text = textOf(out.messages[1])
    assert.match(text, /Always pass it here/)
    assert.doesNotMatch(text, /Omitting containerTag also lands here/)
  })

  test('stays silent when every hit is already in context', async () => {
    respond = json({ searchResults: { results: [{ memory: 'chose Drizzle over Prisma', similarity: 0.9 }] } })
    const repo = makeRepo('git@github.com:acme/repeats.git')
    const { ctx, listener } = fakeCtx()
    registerRecall(ctx, createRuntime(ctx, repo), RECALL_CONFIG)
    const preStep = listener('agent/pre-step')
    const agent = agentIn(repo, 'discovery-c')
    const messages = [prompt('which ORM did we pick for this?')]

    const first = await preStep({ agent, messages }, enter(messages))
    const recalled = textOf(first.messages[1])
    assert.match(recalled, /chose Drizzle over Prisma/)
    assert.match(recalled, /defaults to this project's container/)
    assert.doesNotMatch(recalled, /omit containerTag to search the account/i)

    const second = await preStep({ agent, messages }, enter(messages))
    assert.equal(second.messages.length, 1, 'repeats must not trigger the empty-container notice')
  })

  test('reports a failed recall that is not a timeout', async () => {
    respond = res => res.destroy()
    const repo = makeRepo('git@github.com:acme/broken.git')
    const { ctx, listener, logs } = fakeCtx()
    registerRecall(ctx, createRuntime(ctx, repo), RECALL_CONFIG)
    const messages = [prompt('what did we decide about the auth flow?')]

    const out = await listener('agent/pre-step')({ agent: agentIn(repo, 'broken'), messages }, enter(messages))
    assert.equal(out.messages.length, 1)
    assert.ok(logs.some(line => line.includes('recall failed')))
  })

  test('recognizes the error a timed-out fetch really rejects with', async () => {
    respond = () => {}
    const error = await fetch(process.env.SUPERMEMORY_API_URL!, { signal: AbortSignal.timeout(50) })
      .then(() => null, (err: unknown) => err)
    assert.equal(isTimeout(error), true)
    assert.equal(isTimeout(Object.assign(new Error('x'), { name: 'AbortError' })), true)
    assert.equal(isTimeout(new Error('ECONNRESET')), false)
    assert.equal(isTimeout(null), false)
  })
})

describe('tool gate', () => {
  const hostRepo = makeRepo('git@github.com:acme/host.git')
  const sessionRepo = makeRepo('git@github.com:acme/session.git')
  const ASK = { kind: 'ask' }

  function gate(config: Record<string, unknown> = {}) {
    const { ctx, listener } = fakeCtx()
    const rt = createRuntime(ctx, hostRepo)
    registerApprove(ctx, rt, { autoApprove: true, mcp: true, mcpServerName: 'supermemory', ...config })
    const preExecute = listener('tools/pre-execute')
    const run = (name: string, args: unknown, cwd = sessionRepo, id = 'gate') =>
      preExecute({ name, arguments: args, agent: agentIn(cwd, id) }, async () => ASK)
    return { rt, run }
  }

  test('refuses a tag-less space-scoped call the host proxy would mis-scope', async () => {
    const { run } = gate()
    const decision = await run('mcp__supermemory__search_memory', { query: 'auth' })
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, new RegExp(`Retry with containerTag: "${getContainerTag(sessionRepo)}"`))
    assert.match(decision.reason, new RegExp(getContainerTag(hostRepo)))

    const write = await run('mcp__supermemory__add_memory', { content: 'remember this' })
    assert.equal(write.kind, 'deny', 'a mis-scoped write is refused before anyone approves it')
  })

  test('lets explicit tags, matching sessions, and unscoped tools through', async () => {
    const { run } = gate()
    const tag = getContainerTag(sessionRepo)
    assert.deepEqual(await run('mcp__supermemory__search_memory', { query: 'auth', containerTag: tag }), { kind: 'allow' })
    assert.deepEqual(await run('mcp__supermemory__search_memory', { query: 'auth' }, hostRepo), { kind: 'allow' })
    assert.deepEqual(await run('mcp__supermemory__list_spaces', {}), { kind: 'allow' })
    assert.deepEqual(await run('mcp__supermemory__who_am_i', undefined), { kind: 'allow' })
    assert.equal(await run('mcp__supermemory__add_memory', { content: 'x', containerTag: tag }), ASK)
    assert.deepEqual(
      await run('mcp__plugin_supermemory_supermemory__search_memory', { query: 'auth' }),
      { kind: 'allow' },
      'another server\'s namespace is not scoped by this proxy',
    )
  })

  test('approves add_memory only while an index run is the latest prompt', async () => {
    const { rt, run } = gate()
    const args = { content: 'architecture notes', containerTag: getContainerTag(sessionRepo) }
    assert.equal(await run('mcp__supermemory__add_memory', args, sessionRepo, 'indexer'), ASK)
    rt.indexing.add('indexer')
    assert.deepEqual(await run('mcp__supermemory__add_memory', args, sessionRepo, 'indexer'), { kind: 'allow' })
    assert.equal(await run('mcp__supermemory__save-memory', args, sessionRepo, 'indexer'), ASK)
  })

  test('keeps guarding when auto-approval is off', async () => {
    const { rt, run } = gate({ autoApprove: false })
    rt.indexing.add('gate')
    assert.equal((await run('mcp__supermemory__search_memory', { query: 'auth' })).kind, 'deny')
    assert.equal(await run('mcp__supermemory__search_memory', { query: 'a', containerTag: 't' }), ASK)
    assert.equal(await run('mcp__supermemory__add_memory', { content: 'x', containerTag: 't' }), ASK)
  })

  test('does not guard when the proxy is not mounted', async () => {
    const { ctx, listener } = fakeCtx()
    registerApprove(ctx, createRuntime(ctx, null), { autoApprove: true, mcp: false })
    const decision = await listener('tools/pre-execute')(
      { name: 'mcp__supermemory__search_memory', arguments: { query: 'auth' }, agent: agentIn(sessionRepo, 'g') },
      async () => ASK,
    )
    assert.deepEqual(decision, { kind: 'allow' })
  })
})

describe('codebase index', () => {
  test('registers a user-only skill and tracks the prompt that invokes it', async () => {
    const { ctx, listener, skills } = fakeCtx()
    const rt = createRuntime(ctx, null)
    registerCodebaseIndex(ctx, rt)

    assert.equal(skills.length, 1)
    assert.equal(skills[0]!.name, 'supermemory-index')
    assert.deepEqual(skills[0]!.invocation, { modelInvocable: false, userInvocable: true })
    assert.match(skills[0]!.content as string, /^# Codebase Indexing/)

    const preStep = listener('agent/pre-step')
    const agent = agentIn(HOME, 'idx')
    const step = (messages: unknown[]) => preStep({ agent, messages }, enter(messages))

    await step([prompt('/supermemory-index')])
    assert.ok(rt.indexing.has('idx'))
    await step([])
    assert.ok(rt.indexing.has('idx'), 'a tool-round step keeps the run active')
    await step([{ source: { kind: 'skill-invocation', name: 'x', form: 'instructions' }, content: [{ type: 'text', text: 'body' }] }])
    assert.ok(rt.indexing.has('idx'), 'injected context is not a new human prompt')
    await step([prompt('thanks, now fix the tests')])
    assert.equal(rt.indexing.has('idx'), false, 'the next human prompt ends the run')

    await step([prompt('please /supermemory-index this repo')])
    assert.ok(rt.indexing.has('idx'))
    listener('agent/disposed')({ agent })
    assert.equal(rt.indexing.has('idx'), false)
  })

  test('ignores look-alike tokens', async () => {
    const { ctx, listener } = fakeCtx()
    const rt = createRuntime(ctx, null)
    registerCodebaseIndex(ctx, rt)
    const preStep = listener('agent/pre-step')
    for (const text of ['/supermemory-indexer', 'see docs/supermemory-index', '/supermemory-index.']) {
      const messages = [prompt(text)]
      await preStep({ agent: agentIn(HOME, 'look'), messages }, enter(messages))
      assert.equal(rt.indexing.has('look'), false, text)
    }
  })
})
