# dsh-supermemory

Persistent memory across [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) sessions, using [Supermemory](https://supermemory.ai).

A native port of the Claude Code `supermemory` plugin v0.1.6 ([supermemoryai/claude-supermemory](https://github.com/supermemoryai/claude-supermemory)). Same memories, same containers, same credentials file, same wire format — so a repository you have been working on in Claude Code arrives in DSH already remembering, and everything DSH captures shows up in Claude Code.

## What it does

- **Recalls at session start.** Your project's memory profile is fetched and injected before the first model request.
- **Recalls on every prompt.** Each substantive prompt searches supermemory and injects the relevance-ranked matches, deduplicated for the life of the session, instead of waiting for the model to spend a tool call.
- **Captures every turn.** When a turn closes, the new conversation delta is condensed into durable memory under this repository's container.
- **Runs read-only memory tools without asking.** `search_memory`, `listSpaces`, `whoAmI` and friends never raise an approval prompt; writes still do.
- **Mounts the hosted MCP server.** The bundled stdio proxy authenticates with the same key, so `mcp__supermemory__*` tools are available with no extra configuration.

Everything recalled from supermemory is marked `◪`, and the model is instructed to keep that mark when it cites a memory.

## Install

```sh
dsh plugin --profile <name> add dsh-supermemory
```

Restart the profile. On the first session with no stored key, the browser login opens; the key lands in `~/.supermemory-claude/credentials.json`, the same file the Claude Code plugin uses. Alternatively set `SUPERMEMORY_CC_API_KEY`.

Nothing else is required — the bundle contributes its own patch row.

## Configuration

Override the row in `~/.dsh/profiles/<name>/cordis.patch.yml` (or `~/.dsh/cordis.patch.yml` for every profile). A patch replaces the whole `config` block, so restate every key you want:

```yaml
- id: supermemory
  config:
    injectProfile: true
    recall: true
    capture: true
    autoApprove: true
    browserLogin: true
    mcp: true
    mcpServerName: supermemory
    command: true
    contextGatherer: true
    includeSubagents: false
```

| Key | Default | Meaning |
|---|---|---|
| `injectProfile` | `true` | Inject this project's memory profile at session start |
| `recall` | `true` | Search supermemory with each prompt and inject the matches |
| `capture` | `true` | Save each turn's delta back to supermemory |
| `autoApprove` | `true` | Run read-only supermemory MCP tools without an approval prompt |
| `browserLogin` | `true` | Open the browser login when no API key is configured |
| `mcp` | `true` | Mount the hosted supermemory MCP server through the bundled proxy |
| `mcpServerName` | `supermemory` | MCP namespace; tools surface as `mcp__<name>__<tool>` |
| `command` | `true` | Register `/supermemory-status` |
| `contextGatherer` | `true` | Register the `supermemory-context-gatherer` skill |
| `includeSubagents` | `false` | Recall into and capture from delegated subagent sessions too |

### Environment and files

| Where | What |
|---|---|
| `SUPERMEMORY_CC_API_KEY` | API key; wins over every stored credential |
| `SUPERMEMORY_API_URL` | API base URL (default `https://api.supermemory.ai`) |
| `SUPERMEMORY_MCP_URL` | MCP endpoint (default `https://mcp.supermemory.ai/mcp`) |
| `SUPERMEMORY_AUTH_URL` | Login page used by the browser flow |
| `SUPERMEMORY_REPO_TAG` | Force one memory container tag |
| `SUPERMEMORY_ISOLATE_WORKTREES` | `true` gives each linked git worktree its own container |
| `SUPERMEMORY_DEBUG` | `true` logs every decision with timestamps |
| `~/.supermemory-claude/credentials.json` | Stored API key (shared with the Claude Code plugin) |
| `~/.supermemory-claude/settings.json` | User settings: `maxProfileItems`, `includeTools`, `recallDirective`, `signalExtraction`, `signalKeywords`, `signalTurnsBefore`, `debug` |
| `<repo>/.claude/.supermemory-claude/config.json` | Per-project overrides: `apiKey`, `baseUrl`, `repoContainerTag`, `includeTools`, signal and recall keys |
| `~/.supermemory-claude/statusline/` | Per-session status state, pruned after 7 days |
| `~/.supermemory-claude/trackers/` | Per-session capture cursor |

## Memory containers

A container tag is derived from the git remote, normalized so `git@github.com:acme/Widgets.git` and `https://github.com/ACME/widgets/` resolve to one identity: `repo_<name>__<16 hex>`. Linked worktrees share the main checkout's container unless `SUPERMEMORY_ISOLATE_WORKTREES=true`. A repository with no remote falls back to its resolved path. `repoContainerTag` in the project config wins over everything, which is how a team shares one container.

The derivation is byte-identical to the Claude Code plugin's, so both tools read and write the same container for the same repository.

## Status

```
/supermemory-status
```

Reports the active project and container tag, whether a key is present and where it came from (never more than the first 6 and last 4 characters), and — because a stored key proves nothing — the result of a live `POST /v4/profile` probe, interpreted loudly: `401`/`403` means reachable but revoked, which is the silent-failure case the probe exists to catch. It also counts the registered `mcp__supermemory__*` tools.

## Deeper history

The `supermemory-context-gatherer` skill fans several searches out across the project's containers and returns a synthesized brief with provenance. Use it when starting significant work, resuming after time away, or when one memory search cannot cover the history the conversation needs.

## How the Claude Code plugin maps onto DSH

DSH has no command-hook runner, no markdown command loader, and no markdown agent loader. Each Claude Code hook becomes a typed listener on the equivalent DSH extension point:

| Claude Code | DSH |
|---|---|
| `SessionStart` hook | `agent/session-start` listener, delivered through the first `agent/pre-step` |
| `UserPromptSubmit` hook | `agent/pre-step` waterfall, folded onto the `enter` decision |
| `PreToolUse` hook (`mcp__.*supermemory.*`) | `tools/pre-execute` waterfall, registered `prepend: true`, returning `{ kind: 'allow' }` |
| `Stop` hook (async) | `agent/turn-stopping` serial listener, awaited before the turn commits |
| `.mcp.json` server | `@deepseek-ai/dsh-mcp-client` mounted as a child plugin |
| `commands/status.md` | `ctx.commands.register('supermemory-status')` |
| `agents/context-gatherer.md` | `ctx.skills.register('supermemory-context-gatherer')` |

DSH dispatches those points to every agent, including delegated subagents, while Claude Code's hooks only ever see the main session. Delegated sessions are therefore filtered out by default; set `includeSubagents: true` to let subagent work recall and capture too.

Two further differences are worth stating plainly:

**Session-start delivery is stronger here.** `agent/session-start` is an emit point that DSH never awaits, so an async memory fetch started there can miss the first request — the same gap the Claude Code hooks bridge documents. This plugin parks the fetch and the first `agent/pre-step`, which *is* awaited, folds it in. The first request always carries the project's memory.

**There is no status line to install.** Claude Code's plugin writes a `statusLine` entry into `~/.claude/settings.json`; DSH's status line is host-owned and takes no plugin command. The per-session state files are written exactly as before and the animated renderer ships as an entry point, so any status bar that can run a command renders the identical line:

```sh
echo '{"session_id":"<id>"}' | node -e "import('dsh-supermemory/statusline')"
```

Live one-line notices ("3 memories loaded for widgets", "recalled 2 memories") go to the logger, because DSH exposes no transient user-message channel equivalent to a hook `systemMessage`.

## Development

```sh
pnpm install
pnpm run check      # typecheck + tests + build
```

Requires Node `^22.19.0 || >=24.0.0`.

## License

MIT. Derived from the MIT-licensed Claude Code `supermemory` plugin — see [NOTICE](NOTICE) for the file-by-file attribution. Supermemory, the `◪` mark, and the Supermemory brand belong to Supermemory; this is an independent port, not an official release.
