/**
 * Bridges DSH's stdio MCP transport to the hosted Supermemory MCP server,
 * authenticating with the same credentials file the plugin uses — one browser
 * login covers both. Messages are forwarded sequentially to preserve JSON-RPC
 * ordering; SSE responses are unwrapped back into stdout lines.
 */
import readline from 'node:readline'
import { getApiKey } from './lib/settings.ts'

const MCP_URL = process.env.SUPERMEMORY_MCP_URL || 'https://mcp.supermemory.ai/mcp'
const REQUEST_TIMEOUT_MS = 30000

let sessionId: string | null = null

interface JsonRpcMessage {
  id?: string | number | null
  [key: string]: unknown
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
  let apiKey: string | null = null
  let keyError: unknown = null
  try {
    apiKey = getApiKey(process.cwd())
  } catch (err) {
    keyError = err
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
