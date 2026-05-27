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
import { initWorkflow } from '../workflows/init-workflow'
import { triageWorkflow } from '../workflows/triage-workflow'
import { sliceWorkflow } from '../workflows/slice-workflow'
import { resolveContext } from './context'

const { mastraDbPath, observabilityDbPath } = resolveContext()

export const mastra = new Mastra({
  // The implement pipeline is no longer a Mastra workflow — it runs on the
  // in-house @mars/workflow engine (see workflows/implement-workflow.ts,
  // dispatched from daemon/server.ts via runWorkflow). The remaining three
  // workflows (init/triage/slice) stay on Mastra.
  workflows: {
    initWorkflow,
    triageWorkflow,
    sliceWorkflow,
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: `file:${mastraDbPath}`,
    }),
    domains: process.env.MARS_DISABLE_DUCKDB === '1'
      ? {}
      : {
          observability: await new DuckDBStore({ path: observabilityDbPath }).getStore('observability'),
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
