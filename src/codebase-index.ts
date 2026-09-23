import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { registerBundledSkill } from './context-gatherer.ts'
import { sessionIdOf, type SupermemoryRuntime } from './runtime.ts'

export const INDEX_SKILL_NAME = 'supermemory-index'

// The same token boundary dsh-tool-skill uses to recognize a `/name` gesture.
const GESTURE = new RegExp(`(^|\\s)\\/${INDEX_SKILL_NAME}(?=\\s|$)`)

/** Whether a direct human prompt among `messages` invokes `/supermemory-index`. */
export function invokesIndex(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'user'
    && message.content.some(block => block.type === 'text' && GESTURE.test(block.text)))
}

/**
 * Upstream's `/supermemory:index` is a prompt command. DSH has no markdown
 * command loader, so the same prompt ships as a user-only skill: typing
 * `/supermemory-index` loads it through dsh-tool-skill, and the model's skill
 * catalog never offers it. While the prompt that invoked it is the latest
 * one, its `add_memory` writes are approved the way the command's
 * `allowed-tools` approves them upstream.
 */
export function registerCodebaseIndex(ctx: Context, rt: SupermemoryRuntime): void {
  registerBundledSkill(ctx, rt, INDEX_SKILL_NAME, { modelInvocable: false, userInvocable: true })

  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    // Steps after a tool round claim no human prompt and keep the current state.
    if (messages.some(message => message.source.kind === 'user')) {
      const sessionId = sessionIdOf(agent)
      if (invokesIndex(messages)) rt.indexing.add(sessionId)
      else rt.indexing.delete(sessionId)
    }
    return next()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    rt.indexing.delete(sessionIdOf(agent))
  })
}
