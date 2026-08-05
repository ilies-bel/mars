/**
 * `diagnose` command group: `set` (record a diagnosis verdict from JSON on
 * stdin/file) and `show` (print the stored verdict, optionally as JSON).
 */

import { readFileSync } from 'node:fs'
import {
  setDiagnosis,
  getDiagnosis,
  DIAGNOSIS_KINDS,
} from '../../core/lib/diagnose'
import { hasFlag } from '../args'
import type { Command } from '../command'
import { errorMessage } from './shared'

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const diagnoseSet: Command = {
  path: 'diagnose set',
  summary: 'record a diagnosis verdict for a task (JSON in)',
  usage: 'usage: mars diagnose set <task-id> --from <-|path>',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars diagnose set <task-id> --from <-|path>')
      return { code: 2 }
    }
    const from = args.flags['--from']
    if (!from) {
      deps.err('usage: mars diagnose set <task-id> --from <-|path>')
      return { code: 2 }
    }
    let raw: string
    try {
      raw = from === '-' ? await readStdin() : readFileSync(from, 'utf8')
    } catch (err) {
      deps.err(`failed to read input: ${errorMessage(err)}`)
      return { code: 2 }
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      deps.err(`invalid JSON: ${errorMessage(err)}`)
      return { code: 2 }
    }
    if (typeof json !== 'object' || json === null) {
      deps.err(
        `diagnose set: input must be a JSON object with a 'kind' field (${DIAGNOSIS_KINDS.join(', ')})`,
      )
      return { code: 2 }
    }
    try {
      await setDiagnosis(taskId, json as Parameters<typeof setDiagnosis>[1])
      deps.out(`diagnosis recorded for ${taskId}`)
    } catch (err) {
      deps.err(`diagnose set: ${errorMessage(err)}`)
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const diagnoseShow: Command = {
  path: 'diagnose show',
  summary: 'show the stored diagnosis verdict for a task',
  usage: 'usage: mars diagnose show <task-id> [--json]',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars diagnose show <task-id> [--json]')
      return { code: 2 }
    }
    const verdict = await getDiagnosis(taskId)
    if (hasFlag(args, '--json')) {
      deps.out(JSON.stringify(verdict, null, 2))
      return { code: 0 }
    }
    deps.out(`task: ${verdict.taskId}`)
    deps.out(`kind: ${verdict.kind}`)
    if (verdict.kind === 'root-cause-found') {
      deps.out(`recorded-at: ${verdict.recordedAt}`)
      deps.out(`evidence:`)
      deps.out(`  ${verdict.evidence}`)
      deps.out(`involved-files:`)
      for (const f of verdict.involvedFiles) deps.out(`  ${f}`)
      deps.out(`fix-direction:`)
      deps.out(`  ${verdict.fixDirection}`)
    } else if (verdict.kind === 'inconclusive') {
      deps.out(`recorded-at: ${verdict.recordedAt}`)
      deps.out(`what-checked:`)
      deps.out(`  ${verdict.whatChecked}`)
      deps.out(`why-unscoped:`)
      deps.out(`  ${verdict.whyUnscoped}`)
    } else {
      deps.out('(no verdict recorded for this task)')
    }
    return { code: 0 }
  },
}

const diagnoseRun: Command = {
  path: 'diagnose run',
  summary: 'trigger daemon-side failure diagnosis for a task (Sonnet)',
  usage: 'usage: mars diagnose run <task-id>',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars diagnose run <task-id>')
      return { code: 2 }
    }
    let result: unknown
    try {
      result = await deps.daemon.sendRequest(
        { op: 'diagnose-failure', id: taskId },
      )
    } catch (err) {
      deps.err(`diagnose run: ${errorMessage(err)}`)
      return { code: 1 }
    }
    const diagnosis =
      result !== null &&
      typeof result === 'object' &&
      'diagnosis' in result &&
      typeof (result as { diagnosis: unknown }).diagnosis === 'string'
        ? (result as { diagnosis: string }).diagnosis
        : String(result)
    deps.out(diagnosis)
    return { code: 0 }
  },
}

const diagnoseInvestigate: Command = {
  path: 'diagnose investigate',
  summary: 'trigger daemon-side worktree investigation for a task (Haiku)',
  usage: 'usage: mars diagnose investigate <task-id>',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars diagnose investigate <task-id>')
      return { code: 2 }
    }
    let result: unknown
    try {
      result = await deps.daemon.sendRequest(
        { op: 'investigate', id: taskId },
      )
    } catch (err) {
      deps.err(`diagnose investigate: ${errorMessage(err)}`)
      return { code: 1 }
    }
    const explanation =
      result !== null &&
      typeof result === 'object' &&
      'explanation' in result &&
      typeof (result as { explanation: unknown }).explanation === 'string'
        ? (result as { explanation: string }).explanation
        : String(result)
    deps.out(explanation)
    return { code: 0 }
  },
}

const diagnoseGroup: Command = {
  path: 'diagnose',
  summary: 'diagnose subcommands',
  usage:
    'usage: mars diagnose <run <task-id> | investigate <task-id> | set <task-id> --from <-|path> | show <task-id> [--json]>',
  run: (_args, deps) => {
    deps.err(
      'usage: mars diagnose <run <task-id> | investigate <task-id> | set <task-id> --from <-|path> | show <task-id> [--json]>',
    )
    return { code: 1 }
  },
}

export const diagnoseCommands: readonly Command[] = [
  diagnoseRun,
  diagnoseInvestigate,
  diagnoseSet,
  diagnoseShow,
  diagnoseGroup,
]
