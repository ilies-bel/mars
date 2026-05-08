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
import { verifyPassedScorer } from './scorers/verify-passed'
import { mergeCleanScorer } from './scorers/merge-clean'
import { resolveContext } from './context'

const { mastraDbPath } = resolveContext()

export const mastra = new Mastra({
  workflows: { implementWorkflow, initWorkflow, triageWorkflow },
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
      observability: await new DuckDBStore().getStore('observability'),
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
