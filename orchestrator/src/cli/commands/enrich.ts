/**
 * `enrich` command group: the operator/Writer surface of the gate-enrichment
 * registry (PRD 745f33e0).
 *
 * - `list` / `show`  — enumerate the registry: every claimed signature with
 *                      status, family (or explicit non-encodable reason),
 *                      seen count, and burn-in progress. This is the
 *                      monotonic-coverage boundary made visible.
 * - `draft`          — the Writer's landing verb: set the candidate's
 *                      VerifyStepSpec-shaped check (JSON inline or on stdin).
 * - `approve`        — HUMAN gate: candidate → shadow. Never enforcing —
 *                      burn-in promotes shadow → enforcing after enough
 *                      clean parses. The completeness-gate incident
 *                      (d9237119, 2026-07-03: failed 100% of tasks and
 *                      blocked its own fix) is why there is no shortcut.
 * - `retire`         — flip a wrong check to retired; the signature stays
 *                      claimed so no candidate is regenerated.
 * - `reopen`         — explicit operator verb: retired → candidate.
 *
 * approve/retire supersede the `gate-enrichment` action-queue row for the
 * signature (ADR-0048: the verb mutates the entity; the row clears itself).
 */

import type { Command, CommandDeps } from '../command'
import {
  approveEnrichment,
  getEnrichment,
  listEnrichments,
  reopenEnrichment,
  retireEnrichment,
  setEnrichmentDraftStep,
  type EnrichmentRecord,
} from '../../core/lib/gate-enrichment'
import { SHADOW_BURN_IN_COUNT } from '../../core/lib/gate-burn-in'
import { errorMessage } from './shared'

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const printRecord = (deps: CommandDeps, rec: EnrichmentRecord): void => {
  deps.out(`signature:   ${rec.signature}`)
  deps.out(`status:      ${rec.status}`)
  if (rec.encodableFamily !== null) {
    deps.out(`family:      ${rec.encodableFamily}`)
  }
  if (rec.nonEncodableReason !== null) {
    deps.out(`reason:      ${rec.nonEncodableReason} (not statically encodable)`)
  }
  deps.out(`origin task: ${rec.originTaskId}`)
  deps.out(`seen count:  ${rec.seenCount}`)
  if (rec.stepSpec !== null) {
    deps.out(
      `check:       ${rec.stepSpec.cmd} ${rec.stepSpec.args.join(' ')} (dir: ${rec.stepSpec.dir ?? '.'})`,
    )
  }
  if (rec.approvedBy !== null) {
    deps.out(`approved:    by ${rec.approvedBy} at ${rec.approvedAt ?? '?'}`)
  }
  if (rec.retiredAt !== null) {
    deps.out(`retired at:  ${rec.retiredAt}`)
  }
}

/**
 * Close the signature's open `gate-enrichment` action-queue row after an
 * approve/retire decision. Best-effort — the entity mutation has already
 * committed; a projection hiccup must not fail the verb.
 */
const clearApprovalRow = async (signature: string): Promise<void> => {
  try {
    const { supersedeActionQueueItemsBySignature } = await import(
      '../../core/lib/action-queue'
    )
    await supersedeActionQueueItemsBySignature(
      'gate-enrichment',
      `gate-enrichment:${signature}`,
      'enrichment-decided',
      'cli:enrich',
    )
  } catch {
    // Non-fatal: the registry mutation is the source of truth (ADR-0048).
  }
}

const enrichList: Command = {
  path: 'enrich list',
  summary: 'list the gate-enrichment registry (status, seen count, burn-in)',
  usage: 'usage: mars enrich list',
  run: async (_args, deps) => {
    const entries = await listEnrichments(deps.store)
    if (entries.length === 0) {
      deps.out('(gate-enrichment registry is empty — no failure signature has been observed yet)')
      return { code: 0 }
    }
    for (const e of entries) {
      const detail =
        e.status === 'non-encodable'
          ? `reason=${e.nonEncodableReason ?? 'unclassified'}`
          : e.status === 'shadow'
            ? `family=${e.encodableFamily ?? '?'} burn-in=${e.burnInParseCount}/${SHADOW_BURN_IN_COUNT}`
            : `family=${e.encodableFamily ?? '?'}`
      deps.out(
        `${e.signature}  [${e.status}]  seen=${e.seenCount}  ${detail}  origin=${e.originTaskId}`,
      )
    }
    return { code: 0 }
  },
}

const enrichShow: Command = {
  path: 'enrich show',
  summary: 'show one gate-enrichment record by failure signature',
  usage: 'usage: mars enrich show "<signature>"',
  run: async (args, deps) => {
    const signature = args.positional[0]
    if (!signature) {
      deps.err('usage: mars enrich show "<signature>"')
      return { code: 1 }
    }
    const rec = await getEnrichment(deps.store, signature)
    if (rec === null) {
      deps.err(`no gate-enrichment record for signature "${signature}"`)
      return { code: 1 }
    }
    printRecord(deps, rec)
    return { code: 0 }
  },
}

const enrichDraft: Command = {
  path: 'enrich draft',
  summary: "land a candidate check's step spec (Writer verb; JSON inline or '-' for stdin)",
  usage:
    'usage: mars enrich draft "<signature>" (\'{"cmd":"...","args":[...],"dir":"."}\' | -)',
  run: async (args, deps) => {
    const signature = args.positional[0]
    const rawArg = args.positional[1]
    if (!signature || !rawArg) {
      deps.err(
        'usage: mars enrich draft "<signature>" (\'{"cmd":"...","args":[...],"dir":"."}\' | -)',
      )
      return { code: 1 }
    }
    const raw = rawArg === '-' ? await readStdin() : rawArg
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e: unknown) {
      deps.err(`draft is not valid JSON: ${errorMessage(e)}`)
      return { code: 1 }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      deps.err('draft must be a JSON object: {"cmd": "...", "args": [...], "dir": "."}')
      return { code: 1 }
    }
    const o = parsed as Record<string, unknown>
    if (typeof o.cmd !== 'string' || o.cmd.trim().length === 0) {
      deps.err('draft requires a non-empty string "cmd"')
      return { code: 1 }
    }
    const cmdArgs = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string')
      : []
    const dir = typeof o.dir === 'string' && o.dir.length > 0 ? o.dir : '.'
    try {
      const rec = await setEnrichmentDraftStep(deps.store, signature, {
        cmd: o.cmd,
        args: cmdArgs,
        dir,
      })
      deps.out(`draft landed on candidate enrich:${signature}`)
      printRecord(deps, rec)
      return { code: 0 }
    } catch (e: unknown) {
      deps.err(errorMessage(e))
      return { code: 1 }
    }
  },
}

const enrichApprove: Command = {
  path: 'enrich approve',
  summary: 'approve a candidate check into SHADOW mode (human gate; never enforcing)',
  usage: 'usage: mars enrich approve "<signature>" [--by <name>]',
  run: async (args, deps) => {
    const signature = args.positional[0]
    if (!signature) {
      deps.err('usage: mars enrich approve "<signature>" [--by <name>]')
      return { code: 1 }
    }
    const by = args.flags['--by'] ?? 'operator'
    try {
      const rec = await approveEnrichment(deps.store, signature, by)
      await clearApprovalRow(signature)
      deps.out(
        `approved: enrich:${signature} enters SHADOW mode — it will run on selected verifies but cannot fail them until ${SHADOW_BURN_IN_COUNT} clean parses promote it to enforcing.`,
      )
      printRecord(deps, rec)
      return { code: 0 }
    } catch (e: unknown) {
      deps.err(errorMessage(e))
      return { code: 1 }
    }
  },
}

const enrichRetire: Command = {
  path: 'enrich retire',
  summary: 'retire a check; the signature stays claimed (no regeneration)',
  usage: 'usage: mars enrich retire "<signature>"',
  run: async (args, deps) => {
    const signature = args.positional[0]
    if (!signature) {
      deps.err('usage: mars enrich retire "<signature>"')
      return { code: 1 }
    }
    try {
      const rec = await retireEnrichment(deps.store, signature)
      await clearApprovalRow(signature)
      deps.out(
        `retired: enrich:${signature} will no longer run; the signature stays claimed so no candidate is regenerated (use 'mars enrich reopen' to re-draft).`,
      )
      printRecord(deps, rec)
      return { code: 0 }
    } catch (e: unknown) {
      deps.err(errorMessage(e))
      return { code: 1 }
    }
  },
}

const enrichReopen: Command = {
  path: 'enrich reopen',
  summary: 'reopen a retired signature back to candidate (explicit operator verb)',
  usage: 'usage: mars enrich reopen "<signature>"',
  run: async (args, deps) => {
    const signature = args.positional[0]
    if (!signature) {
      deps.err('usage: mars enrich reopen "<signature>"')
      return { code: 1 }
    }
    try {
      const rec = await reopenEnrichment(deps.store, signature)
      deps.out(`reopened: ${signature} is a candidate again — land a fresh draft and approve it.`)
      printRecord(deps, rec)
      return { code: 0 }
    } catch (e: unknown) {
      deps.err(errorMessage(e))
      return { code: 1 }
    }
  },
}

const enrichGroup: Command = {
  path: 'enrich',
  summary: 'gate-enrichment registry subcommands',
  usage: 'usage: mars enrich <list|show|draft|approve|retire|reopen> ...',
  run: (_args, deps) => {
    deps.err('usage: mars enrich <list|show|draft|approve|retire|reopen> ...')
    return { code: 1 }
  },
}

export const enrichCommands: readonly Command[] = [
  enrichList,
  enrichShow,
  enrichDraft,
  enrichApprove,
  enrichRetire,
  enrichReopen,
  enrichGroup,
]
