/**
 * Behavior tests mirroring the Claude Code plugin's own suite, retargeted at
 * the DSH extension points. `HOME` is redirected before the first import
 * because every settings path is resolved once at module load.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-home-'))
const REAL_HOME = process.env.HOME
process.env.HOME = HOME
process.env.USERPROFILE = HOME
delete process.env.SUPERMEMORY_CC_API_KEY
delete process.env.SUPERMEMORY_REPO_TAG
delete process.env.SUPERMEMORY_API_URL
delete process.env.SUPERMEMORY_ISOLATE_WORKTREES
process.env.NO_COLOR = '1'

const containerTag = await import('../src/lib/container-tag.ts')
const statuslineState = await import('../src/lib/statusline-state.ts')
const statusline = await import('../src/statusline.ts')
const transcript = await import('../src/transcript.ts')
const recall = await import('../src/recall.ts')
const approve = await import('../src/approve.ts')
const sessionStart = await import('../src/session-start.ts')
const status = await import('../src/status.ts')
const contextGatherer = await import('../src/context-gatherer.ts')
const runtime = await import('../src/runtime.ts')

after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME
  fs.rmSync(HOME, { recursive: true, force: true })
})

function makeRepo(remote: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supermemory-repo-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  if (remote) git('remote', 'add', 'origin', remote)
  return fs.realpathSync.native(dir)
}

describe('container tags', () => {
  test('derives one canonical repo tag from the git remote', () => {
    const ssh = makeRepo('git@github.com:acme/Widgets.git')
    const https = makeRepo('https://github.com/ACME/widgets/')
    assert.equal(
      containerTag.getProjectIdentity(ssh),
      containerTag.getProjectIdentity(https),
      'ssh and https remotes for the same repo must share one identity',
    )
    assert.match(containerTag.getGeneratedContainerTag(ssh), /^repo_widgets__[0-9a-f]{16}$/)
  })

  test('falls back to the resolved path when there is no remote', () => {
    const bare = makeRepo(null)
    const tag = containerTag.getGeneratedContainerTag(bare)
    assert.match(tag, /^repo_[a-z0-9_]+__[0-9a-f]{16}$/)
    assert.equal(tag, containerTag.getGeneratedContainerTag(bare), 'the tag must be stable')
  })

  test('honors the project-config override', () => {
    const repo = makeRepo('git@github.com:acme/widgets.git')
    const configDir = path.join(repo, '.claude', '.supermemory-claude')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ repoContainerTag: 'team_shared' }),
    )
    assert.equal(containerTag.getContainerTag(repo), 'team_shared')
  })

  test('normalizes remote spellings down to one key', () => {
    assert.equal(
      containerTag.normalizeGitRemote('git@github.com:ACME/Widgets.git'),
      containerTag.normalizeGitRemote('https://github.com/acme/widgets'),
    )
  })
})

describe('recall', () => {
  test('skips trivial prompts and slash commands', () => {
    assert.equal(recall.shouldSkip('hi'), true)
    assert.equal(recall.shouldSkip('/supermemory-status'), true)
    assert.equal(recall.shouldSkip('!ls -la now please'), true)
    assert.equal(recall.shouldSkip('#tag this conversation'), true)
    assert.equal(recall.shouldSkip('what did we decide about auth?'), false)
  })

  test('reads text from every search-hit shape', () => {
    assert.equal(recall.resultText({ memory: 'a' }), 'a')
    assert.equal(recall.resultText({ chunk: 'b' }), 'b')
    assert.equal(recall.resultText({ content: 'c' }), 'c')
    assert.equal(recall.resultText({ text: 'd' }), 'd')
    assert.equal(recall.resultText({ memory: '   ' }), null)
    assert.equal(recall.resultText(undefined), null)
  })

  test('hashes whitespace-equivalent memories to one dedup key', () => {
    assert.equal(recall.hashText(' a   b \n'), recall.hashText('a b'))
    assert.notEqual(recall.hashText('a b'), recall.hashText('a c'))
  })

  test('formats the recall block with the mark, titles, and filepaths', () => {
    const block = recall.formatRecall(
      [
        { memory: 'chose Drizzle over Prisma', title: 'ORM', filepath: 'docs/adr.md' },
        { memory: 'ORM notes carry their own title', title: 'ORM notes' },
      ],
      'repo_widgets__deadbeefdeadbeef',
    )
    assert.match(block, /^<supermemory-recall>/)
    assert.match(block, /- ◪ ORM — chose Drizzle over Prisma \(docs\/adr\.md\)/)
    assert.match(block, /- ◪ ORM notes carry their own title/)
    assert.ok(!block.includes('ORM notes — ORM notes'), 'a leading title must not be repeated')
    assert.match(block, /containerTag: "repo_widgets__deadbeefdeadbeef"/)
    assert.match(block, /never "from memory"/)
  })

  test('reads the direct prompt and ignores injected context', () => {
    const messages = [
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'ship the ' }] },
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'migration' }] },
      { source: { kind: 'plugin', plugin: 'supermemory' }, content: [{ type: 'text', text: 'IGNORED' }] },
    ]
    assert.equal(recall.promptFrom(messages as never), 'ship the migration')
  })
})

describe('auto-approve', () => {
  test('auto-approves read-only supermemory tools under every namespace', () => {
    assert.equal(approve.readOnlyToolOf('mcp__supermemory__search_memory', 'supermemory'), 'search_memory')
    assert.equal(approve.readOnlyToolOf('mcp__supermemory__whoAmI', 'supermemory'), 'whoAmI')
    assert.equal(
      approve.readOnlyToolOf('mcp__plugin_supermemory_supermemory__listSpaces', 'supermemory'),
      'listSpaces',
    )
    assert.equal(approve.readOnlyToolOf('mcp__claude_ai_supermemory__listMemories', 'supermemory'), 'listMemories')
    assert.equal(approve.readOnlyToolOf('mcp__memories__memory-graph', 'memories'), 'memory-graph')
  })

  test('lets write tools and unrelated tools fall through', () => {
    assert.equal(approve.readOnlyToolOf('mcp__supermemory__addMemory', 'supermemory'), null)
    assert.equal(approve.readOnlyToolOf('mcp__supermemory__save-memory', 'supermemory'), null)
    assert.equal(approve.readOnlyToolOf('read', 'supermemory'), null)
    assert.equal(approve.readOnlyToolOf('mcp__github__create_issue', 'supermemory'), null)
  })
})

describe('session-start context', () => {
  test('formats both profile sections and caps them at maxProfileItems', () => {
    const block = sessionStart.formatContext(
      {
        profile: {
          static: ['prefers pnpm', 'writes TypeScript', 'third'],
          dynamic: ['migrating to Drizzle'],
        },
      },
      2,
      'repo_widgets__deadbeefdeadbeef',
      'widgets',
    )
    assert.match(block as string, /^<supermemory-context>/)
    assert.match(block as string, /## User Profile \(Persistent\)/)
    assert.match(block as string, /- ◪ prefers pnpm/)
    assert.ok(!(block as string).includes('third'), 'maxProfileItems must cap the list')
    assert.match(block as string, /## Recent Context/)
    assert.match(block as string, /memory container: repo_widgets__deadbeefdeadbeef/)
  })

  test('returns null when the profile is empty', () => {
    assert.equal(sessionStart.formatContext({ profile: { static: [], dynamic: [] } }, 5, 'tag', 'p'), null)
    assert.equal(sessionStart.formatContext(null, 5, 'tag', 'p'), null)
  })
})

describe('transcript delta', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_000,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'refactor the auth module\n<system-reminder>hidden</system-reminder>' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'never captured' },
            { type: 'text', text: 'Splitting the session store out first.' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"src/auth.ts"}' },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 1_700_000_002_000,
      data: {
        message: {
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: false }],
        },
      },
    },
  ]

  const session = {
    snapshotEvents(fromSeq?: number) {
      return events.filter(event => event.seq >= (fromSeq ?? 0))
    },
  }

  test('emits the Claude Code wire format and strips reasoning and reminders', () => {
    const cwd = makeRepo('git@github.com:acme/widgets.git')
    const delta = transcript.formatNewEntries(session, 'session-a', cwd)
    assert.ok(delta, 'a delta is expected')
    assert.match(delta!.formatted, /^<\|turn_start\|>2023-11-14T22:13:20\.000Z/)
    assert.match(delta!.formatted, /<\|start\|>user<\|message\|>refactor the auth module<\|end\|>/)
    assert.match(delta!.formatted, /<\|start\|>assistant<\|message\|>Splitting the session store out first\.<\|end\|>/)
    assert.match(delta!.formatted, /<\|turn_end\|>$/)
    assert.ok(!delta!.formatted.includes('never captured'), 'reasoning must never be captured')
    assert.ok(!delta!.formatted.includes('hidden'), 'system reminders must be stripped')
    assert.ok(!delta!.formatted.includes('assistant:tool'), 'tools stay out unless includeTools names them')
    assert.equal(delta!.lastSeq, 3)
  })

  test('advances only from the stored cursor', () => {
    const cwd = makeRepo('git@github.com:acme/widgets.git')
    transcript.setLastCapturedSeq('session-b', 2)
    assert.equal(transcript.getLastCapturedSeq('session-b'), 2)
    const delta = transcript.formatNewEntries(session, 'session-b', cwd)
    // Only the tool result remains, which is below the 100-character floor.
    assert.equal(delta, null)
  })

  test('includes named tools in both directions', () => {
    const cwd = makeRepo('git@github.com:acme/widgets.git')
    const configDir = path.join(cwd, '.claude', '.supermemory-claude')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ includeTools: ['read'] }))
    const delta = transcript.formatNewEntries(session, 'session-c', cwd)
    assert.match(delta!.formatted, /<\|start\|>assistant:tool<\|message\|>read: file_path="src\/auth\.ts"<\|end\|>/)
    assert.match(delta!.formatted, /<\|start\|>assistant:tool_result<\|message\|>read\(success\): ok<\|end\|>/)
  })

  test('projects session events onto user and assistant entries', () => {
    const entries = transcript.entriesFromEvents(events)
    assert.deepEqual(entries.map(entry => entry.type), ['user', 'assistant', 'user'])
    assert.deepEqual(entries.map(entry => entry.seq), [1, 2, 3])
  })
})

describe('statusline state', () => {
  test('isolates sessions and writes private atomic event files', () => {
    const dataDir = path.join(HOME, 'state-a')
    statuslineState.writeState('session-1', 'context', { status: 'ready', memoryItemsLoaded: 3 }, { dataDir })
    statuslineState.writeState('session-2', 'context', { status: 'ready', memoryItemsLoaded: 9 }, { dataDir })

    assert.equal(statuslineState.readState('session-1', { dataDir }).context?.memoryItemsLoaded, 3)
    assert.equal(statuslineState.readState('session-2', { dataDir }).context?.memoryItemsLoaded, 9)

    const dir = statuslineState.getSessionDir('session-1', dataDir) as string
    assert.match(path.basename(dir), /^[a-f0-9]{64}$/, 'the session id must be hashed, never stored raw')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'context.json')).mode & 0o777, 0o600)
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    }
    assert.deepEqual(fs.readdirSync(dir), ['context.json'], 'no temporary file may survive')
  })

  test('clamps and defaults hostile event payloads', () => {
    const dataDir = path.join(HOME, 'state-b')
    statuslineState.writeState('s', 'context', { status: 'bogus', memoryItemsLoaded: -4 }, { dataDir })
    const record = statuslineState.readState('s', { dataDir }).context
    assert.equal(record?.status, 'ready')
    assert.equal(record?.memoryItemsLoaded, 0)
    assert.equal(statuslineState.writeState('s', 'nope' as never, {}, { dataDir }), false)
    assert.equal(statuslineState.writeState('', 'context', {}, { dataDir }), false)
  })

  test('ignores corrupt state instead of throwing', () => {
    const dataDir = path.join(HOME, 'state-c')
    statuslineState.writeState('s', 'capture', { status: 'saved', count: 1 }, { dataDir })
    const dir = statuslineState.getSessionDir('s', dataDir) as string
    fs.writeFileSync(path.join(dir, 'capture.json'), '{ not json')
    assert.equal(statuslineState.readState('s', { dataDir }).capture, null)
  })

  test('prunes only stale hashed session directories', () => {
    const dataDir = path.join(HOME, 'state-d')
    statuslineState.writeState('old', 'context', { status: 'ready' }, { dataDir })
    statuslineState.writeState('new', 'context', { status: 'ready' }, { dataDir })
    const oldDir = statuslineState.getSessionDir('old', dataDir) as string
    const stale = Date.now() - statuslineState.SESSION_RETENTION_MS - 60_000
    for (const file of fs.readdirSync(oldDir)) {
      fs.utimesSync(path.join(oldDir, file), stale / 1000, stale / 1000)
    }
    fs.utimesSync(oldDir, stale / 1000, stale / 1000)

    statuslineState.pruneState({ dataDir })
    assert.equal(fs.existsSync(oldDir), false)
    assert.ok(fs.existsSync(statuslineState.getSessionDir('new', dataDir) as string))
  })
})

describe('statusline rendering', () => {
  const now = 1_700_000_000_000
  const state = (over: Record<string, unknown> = {}) => ({
    context: { version: 1, event: 'context', updatedAt: now - 5_000, status: 'ready', memoryItemsLoaded: 3 },
    ...over,
  })

  test('rests on a live session tally', () => {
    const rendered = statusline.renderStatusline(
      state({
        capture: { version: 1, event: 'capture', updatedAt: now - 1_000, status: 'saved', count: 2 },
        search: { version: 1, event: 'search', updatedAt: now - 1_000, count: 1, memories: 4 },
      }) as never,
      { now, color: false },
    )
    assert.equal(rendered, '◪ supermemory · 3 loaded · 2 captured · 4 recalled')
  })

  test('falls back to a recall count when nothing was injected', () => {
    const label = statusline.getStatusLabel(
      state({ search: { version: 1, event: 'search', updatedAt: now - 1_000, count: 1, memories: 0 } }) as never,
      now,
    )
    assert.equal(label, '3 loaded · 1 recall')
  })

  test('transient states briefly take over the tally', () => {
    const saving = state({ capture: { version: 1, event: 'capture', updatedAt: now - 1_000, status: 'saving', count: 2 } })
    assert.equal(statusline.getStatusLabel(saving as never, now), 'saving session')
    assert.equal(
      statusline.getStatusLabel(saving as never, now + statusline.SAVING_TTL_MS + 1_000),
      '3 loaded · 2 captured',
      'the tally returns once the saving state ages out',
    )
  })

  test('suppresses counts from before the current session context', () => {
    const label = statusline.getStatusLabel(
      {
        context: { version: 1, event: 'context', updatedAt: now, status: 'ready', memoryItemsLoaded: 1 },
        capture: { version: 1, event: 'capture', updatedAt: now - 60_000, status: 'saved', count: 7 },
      } as never,
      now,
    )
    assert.equal(label, '1 loaded', 'a previous session\'s capture count must not leak forward')
  })

  test('renders nothing without fresh context', () => {
    assert.equal(statusline.renderStatusline({}, { now }), '')
    assert.equal(statusline.getStatusLabel({}, now), null)
  })

  test('animates: no frame repeats within any 10s window', () => {
    const live = state({
      capture: { version: 1, event: 'capture', updatedAt: now - 1_000, status: 'saved', count: 2 },
      search: { version: 1, event: 'search', updatedAt: now - 1_000, count: 1, memories: 4 },
    }) as never
    const frames = new Set<string>()
    for (let i = 0; i < 10; i++) {
      frames.add(statusline.renderStatusline(live, { now: now + i * statusline.TICK_MS }))
    }
    assert.equal(frames.size, 10, 'every second must produce a distinct frame')
  })
})

describe('session scoping', () => {
  const agentWith = (header: Record<string, unknown>) => ({ session: { header } }) as never

  test('recognizes delegated sessions so they can be filtered out', () => {
    assert.equal(runtime.isSubagent(agentWith({ id: 'a', origin: 'subagent' })), true)
    assert.equal(runtime.isSubagent(agentWith({ id: 'a' })), false)
    assert.equal(runtime.isSubagent(undefined), false)
  })

  test('reads the session workspace and id, with safe fallbacks', () => {
    assert.equal(runtime.cwdOf(agentWith({ id: 'a', cwd: '/repo' })), '/repo')
    assert.equal(runtime.cwdOf(undefined), process.cwd())
    assert.equal(runtime.sessionIdOf(agentWith({ id: 'abc' })), 'abc')
    assert.equal(runtime.sessionIdOf(undefined), '')
  })
})

describe('status command helpers', () => {
  test('never prints a whole key', () => {
    assert.equal(status.maskKey('sm_1234567890abcdef'), 'sm_123…cdef')
    assert.equal(status.maskKey('short'), 'sh…')
  })
})

describe('context gatherer skill', () => {
  test('parses the shipped SKILL.md frontmatter and body', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'skills', 'supermemory-context-gatherer', 'SKILL.md'),
      'utf-8',
    )
    const { data, body } = contextGatherer.splitFrontmatter(source)
    assert.equal(data.name, 'supermemory-context-gatherer')
    assert.match(data.description as string, /Supermemory/)
    assert.match(body, /^You are the Supermemory context gatherer\./)
    assert.ok(!body.startsWith('---'), 'frontmatter must be stripped from the body')
  })
})
