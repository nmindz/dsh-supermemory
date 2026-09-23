/**
 * Bridges DSH's stdio MCP transport to the hosted Supermemory MCP server,
 * authenticating with the same credentials file the plugin uses — one browser
 * login covers both. Messages are forwarded sequentially to preserve JSON-RPC
 * ordering; SSE responses are unwrapped back into stdout lines.
 *
 * Space-scoped tool calls without a containerTag get the tag of this process's
 * cwd. DSH spawns one proxy per host, so that cwd is the host's, not a
 * session's; the plugin guards sessions whose container differs.
 */
import readline from 'node:readline'
import { getContainerTag } from './lib/container-tag.ts'
import { argumentRecord, explicitContainerTag, REPO_SCOPED_TOOLS } from './lib/mcp-scope.ts'
import { getApiKey } from './lib/settings.ts'

const MCP_URL = process.env.SUPERMEMORY_MCP_URL || 'https://mcp.supermemory.ai/mcp'
const REQUEST_TIMEOUT_MS = 30000

let sessionId: string | null = null

interface JsonRpcMessage {
  id?: string | number | null
  method?: unknown
  params?: unknown
  [key: string]: unknown
}

// Hosted MCP defaults a missing containerTag to activeSpace; default space-scoped calls to this repo instead.
function injectRepoContainerTag(message: JsonRpcMessage, containerTag: string | null): void {
  if (!containerTag || message.method !== 'tools/call') return
  const params = message.params as { name?: unknown; arguments?: unknown } | null | undefined
  if (!params || typeof params !== 'object') return
  if (typeof params.name !== 'string' || !REPO_SCOPED_TOOLS.has(params.name)) return

  const record = argumentRecord(params.arguments)
  if (record === null) {
    params.arguments = { containerTag }
    return
  }
  if (!record || explicitContainerTag(record)) return

  record.containerTag = containerTag
  params.arguments = typeof params.arguments === 'string' ? JSON.stringify(record) : record
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendError(id: string | number | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function emitSseData(text: string): void {
  for (const event of text.split('\n\n')) {
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data) process.stdout.write(`${data}\n`)
      }
    }
  }
}

async function forward(message: JsonRpcMessage, apiKey: string): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const newSessionId = response.headers.get('mcp-session-id')
  if (newSessionId) sessionId = newSessionId

  if (response.status === 202) return
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    sendError(
      message.id,
      -32000,
      `Supermemory MCP ${response.status}: ${text.slice(0, 200) || 'request failed'}`,
    )
    return
  }

  const contentType = response.headers.get('content-type') || ''
  const body = await response.text()
  if (!body.trim()) return

  if (contentType.includes('text/event-stream')) {
    emitSseData(body)
  } else {
    process.stdout.write(`${body.trim()}\n`)
  }
}

function main(): void {
  const cwd = process.cwd()
  let apiKey: string | null = null
  let keyError: unknown = null
  let repoContainerTag: string | null = null
  try {
    apiKey = getApiKey(cwd)
  } catch (err) {
    keyError = err
  }
  try {
    repoContainerTag = getContainerTag(cwd)
  } catch {
    repoContainerTag = null
  }

  let queue = Promise.resolve()
  const rl = readline.createInterface({ input: process.stdin })

  rl.on('line', (line: string) => {
    if (!line.trim()) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    queue = queue.then(async () => {
      if (keyError) {
        sendError(
          message.id,
          -32001,
          'Supermemory is not authenticated. Start a DSH session with the supermemory plugin to log in, or set SUPERMEMORY_CC_API_KEY.',
        )
        return
      }
      try {
        injectRepoContainerTag(message, repoContainerTag)
        await forward(message, apiKey as string)
      } catch (err) {
        sendError(message.id, -32000, `Supermemory MCP proxy error: ${(err as Error).message}`)
      }
    })
  })

  rl.on('close', () => {
    void queue.then(() => process.exit(0))
  })
}

main()
