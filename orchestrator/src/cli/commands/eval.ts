/**
 * `mars eval` — score the eval fixture suite (`../../eval/fixture.ts`,
 * `../../eval/fixtures/*.json`) across the three behaviour dimensions
 * declared in `../../eval/scorers.ts` (slicing, verify, recovery), print a
 * per-dimension + total score, and diff against the last recorded baseline
 * (`.mars/eval-baseline.json`) so a prompt or provider change is measurably
 * better or worse rather than a matter of opinion.
 *
 * `mars eval --baseline` records the current run as that baseline instead of
 * diffing against it.
 *
 * Read-only against the fixture suite (an offline `replayFixture` replay —
 * no network, no subprocess, no git); the only write is the optional
 * baseline file under the repo's `.mars/` state dir.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasFlag } from '../args'
import type { Command } from '../command'
import { evalFixtureSchema, type EvalFixture } from '../../eval/fixture'
import { replayFixture } from '../../eval/replay'
import { scoreRecovery, scoreSlicing, scoreVerify, type ScoreDimension } from '../../eval/scorers'

const DIMENSIONS: readonly ScoreDimension[] = ['slicing', 'verify', 'recovery']

const fixturesDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'fixtures')

/** Load every fixture in `../../eval/fixtures/`, or just `name` when given. */
const loadFixtures = (name: string | undefined): EvalFixture[] => {
  const dir = fixturesDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  const selected = name === undefined ? files : files.filter((f) => f === `${name}.json`)
  return selected
    .slice()
    .sort()
    .map((f) => evalFixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
}

interface DimensionScores {
  slicing: number
  verify: number
  recovery: number
}

const average = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length

const fmtScore = (n: number): string => n.toFixed(3)

const fmtDelta = (delta: number): string => {
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '±'
  return `${sign}${delta.toFixed(3)}`
}

interface BaselineFile {
  dimensions: DimensionScores
  total: number
  recordedAt: string
}

const isBaselineFile = (v: unknown): v is BaselineFile => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (typeof r.total !== 'number' || typeof r.recordedAt !== 'string') return false
  const d = r.dimensions
  if (typeof d !== 'object' || d === null) return false
  const dr = d as Record<string, unknown>
  return DIMENSIONS.every((dim) => typeof dr[dim] === 'number')
}

const evalCommand: Command = {
  path: 'eval',
  summary: 'score the eval fixture suite and diff against the last baseline',
  usage: 'mars eval [--fixture <name>] [--baseline]',
  helpBody: [
    'mars eval [--fixture <name>] [--baseline]',
    '',
    'Replays every fixture under src/eval/fixtures/ (or just the one named by',
    '--fixture) through the offline eval pipeline, scores each replay across',
    'three behaviour dimensions — slicing, verify, recovery — and prints the',
    'per-dimension average plus a total.',
    '',
    'Each dimension has a stated, deterministic rubric (see',
    'src/eval/scorers.ts); replaying the same fixtures always produces the',
    'same scores.',
    '',
    '--baseline records the current scores to .mars/eval-baseline.json instead',
    'of diffing against it. Every other invocation prints the delta against',
    'that recorded baseline, when one exists.',
  ].join('\n'),
  flags: [
    {
      syntax: '--fixture <name>',
      description: 'run only the named fixture (default: every fixture under src/eval/fixtures/)',
    },
    {
      syntax: '--baseline',
      description: 'record the current scores as the baseline instead of diffing against it',
    },
  ],
  run: async (args, deps) => {
    const fixtureName = args.flags['--fixture']
    const recordBaseline = hasFlag(args, '--baseline')

    let fixtures: EvalFixture[]
    try {
      fixtures = loadFixtures(fixtureName)
    } catch (err) {
      deps.err(`error: failed to load fixtures: ${err instanceof Error ? err.message : String(err)}`)
      return { code: 1 }
    }
    if (fixtures.length === 0) {
      deps.err(
        fixtureName !== undefined
          ? `error: no fixture named '${fixtureName}' under src/eval/fixtures/`
          : 'error: no fixtures found under src/eval/fixtures/',
      )
      return { code: 1 }
    }

    const perFixtureScores = await Promise.all(
      fixtures.map(async (fixture) => {
        const transcript = await replayFixture(fixture)
        return {
          slicing: scoreSlicing(transcript).score,
          verify: scoreVerify(transcript).score,
          recovery: scoreRecovery(transcript).score,
        }
      }),
    )

    const dimensions: DimensionScores = {
      slicing: average(perFixtureScores.map((s) => s.slicing)),
      verify: average(perFixtureScores.map((s) => s.verify)),
      recovery: average(perFixtureScores.map((s) => s.recovery)),
    }
    const total = average(DIMENSIONS.map((dim) => dimensions[dim]))

    deps.out(`fixtures scored: ${fixtures.length}`)
    for (const dim of DIMENSIONS) {
      deps.out(`  ${dim.padEnd(10)} ${fmtScore(dimensions[dim])}`)
    }
    deps.out(`  ${'total'.padEnd(10)} ${fmtScore(total)}`)

    const baselinePath = resolve(deps.ctx.stateDir, 'eval-baseline.json')

    if (recordBaseline) {
      mkdirSync(deps.ctx.stateDir, { recursive: true })
      const recorded: BaselineFile = { dimensions, total, recordedAt: new Date().toISOString() }
      writeFileSync(baselinePath, `${JSON.stringify(recorded, null, 2)}\n`)
      deps.out('')
      deps.out(`baseline recorded: ${baselinePath}`)
      return { code: 0 }
    }

    if (!existsSync(baselinePath)) {
      deps.out('')
      deps.out('(no baseline recorded yet — run `mars eval --baseline` to record one)')
      return { code: 0 }
    }

    let baseline: unknown
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    } catch (err) {
      deps.err(`error: failed to read baseline '${baselinePath}': ${err instanceof Error ? err.message : String(err)}`)
      return { code: 1 }
    }
    if (!isBaselineFile(baseline)) {
      deps.err(`error: baseline '${baselinePath}' is malformed; re-record it with 'mars eval --baseline'`)
      return { code: 1 }
    }

    deps.out('')
    deps.out(`delta vs baseline (recorded ${baseline.recordedAt}):`)
    for (const dim of DIMENSIONS) {
      deps.out(`  ${dim.padEnd(10)} ${fmtDelta(dimensions[dim] - baseline.dimensions[dim])}`)
    }
    deps.out(`  ${'total'.padEnd(10)} ${fmtDelta(total - baseline.total)}`)

    return { code: 0 }
  },
}

export const evalCommands: readonly Command[] = [evalCommand]
