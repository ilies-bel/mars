/**
 * `none` CodeIndex implementation — the default. Answers every query with an
 * empty result, matching "no code index available" rather than throwing, so
 * a caller written against this Port behaves exactly as it did before the
 * Port existed: no code-intelligence data, no error.
 */
import type { CodeIndex, ImpactQuery, ImpactResult, SymbolHit, SymbolQuery } from './types'

export const noneCodeIndex: CodeIndex = {
  kind: 'none',
  async symbols(_query: SymbolQuery): Promise<SymbolHit[]> {
    return []
  },
  async search(_query: SymbolQuery): Promise<SymbolHit[]> {
    return []
  },
  async impact(query: ImpactQuery): Promise<ImpactResult> {
    return { symbol: query.symbol, affected: [] }
  },
}
