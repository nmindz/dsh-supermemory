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

Pick a profile name — `tui`, `web`, or whatever you boot with `dsh --profile <name>`. The examples use `tui`.

### From npm

```sh
dsh plugin --profile tui add dsh-supermemory
```

### From a release tarball

```sh
curl -fsSLO https://github.com/nmindz/dsh-supermemory/releases/latest/download/dsh-supermemory.tgz
dsh plugin --profile tui add ./dsh-supermemory.tgz
```

### From GitHub

A git install builds the package on your machine, and pnpm blocks that until you allow it by exact commit. Run the command once to make pnpm print the key, paste the key into the profile's `pnpm-workspace.yaml`, then run it again:

```sh
dsh plugin --profile tui add github:nmindz/dsh-supermemory
# pnpm refuses and prints an allowBuilds key — append it:
cat >> ~/.dsh/profiles/tui/pnpm-workspace.yaml <<'YAML'
allowBuilds:
  dsh-supermemory@git+ssh://git@github.com/nmindz/dsh-supermemory.git#<the-sha-pnpm-printed>: true
YAML
dsh plugin --profile tui add github:nmindz/dsh-supermemory
```

That key is permission to run this package's build script on your machine at install time, outside any sandbox. Pin the commit SHA pnpm printed rather than a branch.

### From a clone

```sh
git clone https://github.com/nmindz/dsh-supermemory.git
cd dsh-supermemory
pnpm install && pnpm run build
dsh plugin --profile tui add "$PWD"
```

### After installing

Restart the profile:

```sh
dsh --profile tui
```

On the first session with no stored key the browser login opens, and the key lands in `~/.supermemory-claude/credentials.json` — the same file the Claude Code plugin uses, so one login covers both. To skip the browser entirely:

```sh
export SUPERMEMORY_CC_API_KEY=sm_your_key_here
```

Confirm the plugin composed into your profile:

```sh
dsh --profile tui --dump-config | grep -A2 'dsh-supermemory'
# == dsh-supermemory
# - id: supermemory
#   name: dsh-supermemory
```

Then, inside a session, check the live connection:

```
/supermemory-status
```

Nothing else is required — the bundle contributes its own patch row.

### Uninstall

```sh
dsh plugin --profile tui remove dsh-supermemory
```

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

## Releasing

Publishing runs from GitHub Actions through npm **trusted publishing (OIDC)** — no `NPM_TOKEN` secret exists, and every release carries provenance. CI does not publish on its own: it *stages* the release, and a human approves it with a 2FA code.

One-time setup on npm: open <https://www.npmjs.com/package/dsh-supermemory/access>, add a trusted publisher, choose GitHub Actions, and enter organization `nmindz`, repository `dsh-supermemory`, workflow `.github/workflows/release.yml`, environment `production`. Under **Allowed actions**, leave *publish directly* unchecked — staged publishing is all this workflow needs, and it keeps CI from holding a credential that can ship a version by itself.

### Conventional Commits drive the version

There is no manual version bump and no hand-written tag. [semantic-release](https://semantic-release.gitbook.io) reads the [Conventional Commits](https://www.conventionalcommits.org) since the last release and decides everything else — the version, `CHANGELOG.md`, the git tag, and the GitHub Release.

| Commit | Result |
|---|---|
| `fix: …` | patch — `0.1.0` → `0.1.1` |
| `feat: …` | minor — `0.1.0` → `0.2.0` |
| `feat!: …` or a `BREAKING CHANGE:` footer | major |
| `perf: …`, `refactor: …` | patch |
| `docs: …`, `test: …`, `chore: …`, `ci: …`, `build: …`, `style: …` | no release |

So a release is just a merge to `master`:

```sh
git commit -m 'fix: render the status line from a symlinked install path'
git push origin master
```

CI validates the commit, the release workflow runs once CI is green, and if the commits warrant a version it bumps `package.json`, writes `CHANGELOG.md`, tags `vX.Y.Z`, opens the GitHub Release, and stages the npm publish. Pull requests get their commit messages linted so a malformed one cannot silently cost a release.

The version then waits for you:

```sh
npm stage list dsh-supermemory   # find the stage id
npm stage view <stage-id>        # inspect the tarball and provenance
npm stage approve <stage-id>     # publishes it; asks for your 2FA code
npm stage reject <stage-id>      # discards it instead
```

Requires npm ≥ 11.19 locally (`npm install -g npm@latest`).

To publish by hand instead, skipping staging entirely:

```sh
pnpm run check
npm publish --access public
```

Run semantic-release in CI only. It moves git refs as part of its work, and in a jj-colocated checkout jj re-imports those refs and rolls the working copy back onto them — locally it looks like it ate your unpushed commits. They are recoverable with `jj op log` and `jj op restore <op-id>`, but the tool has no business running there.

### What a release costs

The package is built exactly once per commit. CI's `build` job produces `lib/`, verifies the tarball still carries the skill body and both auth templates, and uploads it; the release workflow downloads that artifact rather than rebuilding, and stages with `--ignore-scripts` so `prepublishOnly` does not rebuild either. Installs in CI use `--ignore-scripts` too, since the package's `prepare` hook exists only to make a git install usable. Runs on a superseded commit cancel themselves.

## License

MIT. Derived from the MIT-licensed Claude Code `supermemory` plugin — see [NOTICE](NOTICE) for the file-by-file attribution. Supermemory, the `◪` mark, and the Supermemory brand belong to Supermemory; this is an independent port, not an official release.
