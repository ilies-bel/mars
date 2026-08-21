/**
 * `codegraph` CodeIndex implementation — shells out to the `codegraph` CLI
 * (https://github.com/… see `resolveCodegraphRoot`'s doc comment in
 * `../../lib/git/internal.ts` for why the index root differs from `cwd`
 * inside a worktree).
 *
 * Degrades to `none` semantics (empty results, never throws) whenever:
 *   - the `codegraph` binary is absent from PATH (`spawnSync` reports ENOENT);
 *   - the CLI exits non-zero (no index built yet, bad args, etc.);
 *   - the CLI's stdout is not the JSON shape this module expects.
 *
 * This mirrors the "CodeIndex is a soft dependency" posture already
 * documented for interactive sessions (ADR-0062, `CODEGRAPH_CLI_SYSTEM_PROMPT`
 * in `../../lib/git/claude.ts`): a missing or misbehaving `codegraph` must
 * never fail a caller that merely wanted code-intelligence data.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolveCodegraphRoot } from '../../lib/git/internal'
import { noneCodeIndex } from './none'
import type { CodeIndex, ImpactQuery, ImpactResult, SymbolHit, SymbolQuery } from './types'

/** Wall-clock cap on one `codegraph` invocation. A hung index build must not hang the caller. */
const CODEGRAPH_TIMEOUT_MS = 10_000

const DEFAULT_SYMBOLS_LIMIT = 10
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_IMPACT_DEPTH = 2

/** Raw shape of one `codegraph query -j` result entry. */
interface RawQueryHit {
  node?: {
    kind?: unknown
    name?: unknown
    filePath?: unknown
    startLine?: unknown
  }
  score?: unknown
}

/** Raw shape of `codegraph impact -j`'s `affected` entries. */
interface RawAffectedHit {
  name?: unknown
  kind?: unknown
  filePath?: unknown
  startLine?: unknown
}

interface RawImpactResult {
  symbol?: unknown
  affected?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Coerce one raw `affected`/`query` node into a {@link SymbolHit}, or `undefined` if malformed. */
const toSymbolHit = (raw: unknown): SymbolHit | undefined => {
  if (!isRecord(raw)) return undefined
  const { name, kind, filePath, startLine } = raw
  if (typeof name !== 'string' || typeof kind !== 'string' || typeof filePath !== 'string') {
    return undefined
  }
  return {
    name,
    kind,
    filePath,
    startLine: typeof startLine === 'number' ? startLine : 0,
  }
}

/**
 * Run `codegraph <args>` and return parsed stdout as `unknown`, or `undefined`
 * on any failure (missing binary, non-zero exit, timeout, unparsable JSON).
 * The single point every codegraph shell-out routes through so every failure
 * mode degrades identically.
 */
const runCodegraph = (args: readonly string[]): unknown => {
  let result: SpawnSyncReturns<string>
  try {
    result = spawnSync('codegraph', args, {
      encoding: 'utf8',
      timeout: CODEGRAPH_TIMEOUT_MS,
    })
  } catch {
    // spawnSync itself throwing (e.g. sandboxed environments) — treat as absent.
    return undefined
  }
  if (result.error) return undefined // ENOENT: binary not on PATH.
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    return undefined
  }
}

/** Shared shell-out for `symbols()` and `search()` — both wrap `codegraph query`. */
const runQuery = async (query: SymbolQuery, defaultLimit: number): Promise<SymbolHit[]> => {
  const root = resolveCodegraphRoot(query.cwd ?? process.cwd())
  const args = ['query', query.term, '--json', '--path', root, '--limit', String(query.limit ?? defaultLimit)]
  if (query.kind !== undefined) args.push('--kind', query.kind)
  const raw = runCodegraph(args)
  if (!Array.isArray(raw)) return []
  const hits: SymbolHit[] = []
  for (const entry of raw as RawQueryHit[]) {
    const hit = toSymbolHit(entry?.node)
    if (hit === undefined) continue
    hits.push(typeof entry.score === 'number' ? { ...hit, score: entry.score } : hit)
  }
  return hits
}

export const codegraphCodeIndex: CodeIndex = {
  kind: 'codegraph',
  async symbols(query: SymbolQuery): Promise<SymbolHit[]> {
    return runQuery(query, DEFAULT_SYMBOLS_LIMIT)
  },
  async search(query: SymbolQuery): Promise<SymbolHit[]> {
    return runQuery(query, DEFAULT_SEARCH_LIMIT)
  },
  async impact(query: ImpactQuery): Promise<ImpactResult> {
    const root = resolveCodegraphRoot(query.cwd ?? process.cwd())
    const args = [
      'impact',
      query.symbol,
      '--json',
      '--path',
      root,
      '--depth',
      String(query.depth ?? DEFAULT_IMPACT_DEPTH),
    ]
    const raw = runCodegraph(args)
    if (!isRecord(raw)) return noneCodeIndex.impact(query)
    const parsed = raw as RawImpactResult
    const symbol = typeof parsed.symbol === 'string' ? parsed.symbol : query.symbol
    const affectedRaw = Array.isArray(parsed.affected) ? (parsed.affected as RawAffectedHit[]) : []
    const affected = affectedRaw.map(toSymbolHit).filter((hit): hit is SymbolHit => hit !== undefined)
    return { symbol, affected }
  },
}
