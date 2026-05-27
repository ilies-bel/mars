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
import { resolveContext } from './context'

const { mastraDbPath, observabilityDbPath } = resolveContext()

export const mastra = new Mastra({
  // implement/triage/plan/slice now run on the in-house @mars/workflow engine
  // (see src/workflows/*, dispatched from daemon/server.ts via runWorkflow).
  // Only init remains a Mastra workflow (ported next).
  workflows: {
    initWorkflow,
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
