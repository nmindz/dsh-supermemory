import { execSync } from 'node:child_process'
import path from 'node:path'

/**
 * Resolve the repository root for `cwd`. Linked worktrees normally collapse to
 * the main checkout so every worktree shares one memory container;
 * `SUPERMEMORY_ISOLATE_WORKTREES=true` keeps them separate.
 */
export function getGitRoot(cwd: string): string | null {
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === 'true'

  try {
    if (isolateWorktrees) {
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      return gitRoot || null
    }

    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    if (gitCommonDir === '.git') {
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      return gitRoot || null
    }

    const resolved = path.resolve(cwd, gitCommonDir)

    if (
      path.basename(resolved) === '.git'
      && !resolved.includes(`${path.sep}.git${path.sep}`)
    ) {
      return path.dirname(resolved)
    }

    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return gitRoot || null
  } catch {
    return null
  }
}
