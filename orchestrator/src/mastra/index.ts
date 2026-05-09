import { Mastra } from '@mastra/core/mastra'
import { PinoLogger } from '@mastra/loggers'
import { LibSQLStore } from '@mastra/libsql'
import { DuckDBStore } from '@mastra/duckdb'
import { MastraCompositeStore } from '@mastra/core/storage'
import {
  Observability,
  DefaultExporter,
  SensitiveDataFilter,
} from '@mastra/observability'
import { implementWorkflow } from './workflows/implement-workflow'
import { initWorkflow } from './workflows/init-workflow'
import { triageWorkflow } from './workflows/triage-workflow'
import { abExperimentWorkflow } from './workflows/ab-experiment-workflow'
import { verifyPassedScorer } from './scorers/verify-passed'
import { mergeCleanScorer } from './scorers/merge-clean'
import { resolveContext } from './context'

const { mastraDbPath, observabilityDbPath } = resolveContext()

const duckdbStore = new DuckDBStore({ path: observabilityDbPath })

export const mastra = new Mastra({
  workflows: { implementWorkflow, initWorkflow, triageWorkflow, abExperimentWorkflow },
  scorers: {
    verifyPassed: verifyPassedScorer,
    mergeClean: mergeCleanScorer,
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: `file:${mastraDbPath}`,
    }),
    domains: {
      observability: await duckdbStore.getStore('observability'),
    },
  }),
  logger: new PinoLogger({ name: 'orchestrator', level: 'info' }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'orchestrator',
        exporters: [new DefaultExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
})

// Escape hatch for the daemon's `spans` op: the DuckDB file format takes a
// process-exclusive OS lock, so out-of-process readers can't open it. Anything
// reading observability spans goes through this connection.
export const getObservabilityDb = (): DuckDBStore['db'] => duckdbStore.db
