/**
 * CodeIndex Port — code-intelligence queries (symbol lookup, search,
 * change-impact analysis) for a repo, abstracted behind a swappable
 * implementation (ADR-0097 "Every seam is a cordis service Port with
 * serializable contracts").
 *
 * Every argument and result here is plain, JSON-serializable data — no
 * class instances, no functions, nothing that can't cross a process
 * boundary — so a future out-of-process implementation (e.g. a remote
 * code-intelligence service) is a drop-in registration, not a redesign.
 *
 * Two implementations exist today (see `registry.ts`):
 *   - `none`     — the default; always returns empty results.
 *   - `codegraph` — shells out to the `codegraph` CLI, degrading to `none`
 *     semantics whenever the binary is absent or a query fails.
 *
 * The active implementation is selected by `MARS_CODE_INDEX_KIND`
 * (see `../../config/registry.ts`'s `codeIndex` Port entry).
 */

/** One node kind `codegraph` reports (function, class, interface, file, …). Left open — the
 * concrete set is owned by the indexer, not this Port. */
export type SymbolKind = string

/** A query for `CodeIndex.symbols()` / `CodeIndex.search()`. */
export interface SymbolQuery {
  /** Symbol name or free-text search term. */
  term: string
  /** Restrict results to this node kind (e.g. 'function', 'class'). */
  kind?: SymbolKind
  /** Maximum number of results to return. Implementations may cap this lower. */
  limit?: number
  /** Repo root to scope the query. Defaults to the implementation's own resolution (see `resolveCodegraphRoot`). */
  cwd?: string
}

/** One symbol/file match returned by `symbols()` or `search()`, or one entry in `ImpactResult.affected`. */
export interface SymbolHit {
  name: string
  kind: SymbolKind
  filePath: string
  startLine: number
  /** Relevance score, when the implementation ranks results. Absent (not zero) when the implementation doesn't rank. */
  score?: number
}

/** A query for `CodeIndex.impact()`. */
export interface ImpactQuery {
  /** Symbol name to analyze. */
  symbol: string
  /** Traversal depth through the call graph. */
  depth?: number
  /** Repo root to scope the query. Defaults to the implementation's own resolution. */
  cwd?: string
}

/** Change-impact result for one symbol. */
export interface ImpactResult {
  symbol: string
  /** Every symbol/file transitively affected by changing `symbol` (includes `symbol` itself). */
  affected: SymbolHit[]
}

/**
 * The CodeIndex Port contract. Every method is async and every arg/result is
 * serializable — see the module doc comment above.
 */
export interface CodeIndex {
  /** Stable identifier of this implementation (matches its registry.ts `kind`). */
  readonly kind: string
  /** Locate symbol definitions matching `query.term`. */
  symbols(query: SymbolQuery): Promise<SymbolHit[]>
  /** Broader search across symbol/file names for `query.term`. */
  search(query: SymbolQuery): Promise<SymbolHit[]>
  /** Change-impact analysis for `query.symbol`. */
  impact(query: ImpactQuery): Promise<ImpactResult>
}
