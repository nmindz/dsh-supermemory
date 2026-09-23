import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Declaration-merges `ctx.skills` onto Context.
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'
import type { SupermemoryRuntime } from './runtime.ts'

const SKILL_NAME = 'supermemory-context-gatherer'

/**
 * Skills ship at the package root; the built bundle sits one level down and
 * the sources one as well, so both candidates are probed.
 */
export function resolveSkillDir(name: string = SKILL_NAME): string {
  const candidates = [`../skills/${name}/`, `../../skills/${name}/`].map(
    relative => fileURLToPath(new URL(relative, import.meta.url)),
  )
  return candidates.find(dir => fs.existsSync(path.join(dir, 'SKILL.md'))) ?? candidates[0]!
}

/** Strip the YAML frontmatter block a filesystem skill provider would parse. */
export function splitFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source.trim() }
  const data: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { data, body: source.slice(match[0].length).trim() }
}

/** Register one skill shipped under `skills/<name>/SKILL.md`; warns and skips when unreadable. */
export function registerBundledSkill(
  ctx: Context,
  rt: SupermemoryRuntime,
  name: string,
  invocation?: SkillInvocationPolicy,
): void {
  const skillDir = resolveSkillDir(name)
  const skillFile = path.join(skillDir, 'SKILL.md')

  let source: string
  try {
    source = fs.readFileSync(skillFile, 'utf-8')
  } catch (err) {
    rt.warn(`${name} skill not registered — ${skillFile} is unreadable: ${(err as Error).message}`)
    return
  }

  const { data, body } = splitFrontmatter(source)
  const description = data.description
  if (!description || !body) {
    rt.warn(`${name} skill not registered — ${skillFile} is missing a description or body`)
    return
  }

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.register({
      name,
      description,
      content: body,
      source: 'runtime',
      path: skillFile,
      resourceBase: { kind: 'directory', path: skillDir },
      ...(invocation ? { invocation } : {}),
    })
  })
}

/**
 * The Claude Code plugin ships this as a subagent definition under `agents/`.
 * DSH has no markdown agent loader, so the same instructions ship as a skill:
 * one file, discovered by name, invocable by the model or by the user.
 */
export function registerContextGatherer(ctx: Context, rt: SupermemoryRuntime): void {
  registerBundledSkill(ctx, rt, SKILL_NAME)
}
