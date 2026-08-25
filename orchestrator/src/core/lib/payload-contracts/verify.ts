import type { VerifyStepSpec } from '../../ports/verifier/types'

export interface VerifyUncoveredPayload {
  scope: string
  changedPaths: string[]
  recipe: string | null
  proposedGate?: { name: string; cmd: string; args: string[]; scope: string; evidence: string }
}

export interface GateEnrichmentStalePayload {
  signature: string
  passCount: number
  stepSpec?: VerifyStepSpec | null
}

export interface ArcVerificationFailedPayload {
  originId: string
  findings: string[]
  landedCommits: readonly string[]
}

export interface EnvIncidentPayload {
  taskId: string
  signature: string
  envRestartCount: number
}

export interface DirtyIntegrationPayload {
  taskId: string
  integrationBranch: string
  dirtyPaths: string[]
  statusOutput: string
}

export interface VerifyContracts {
  'verify-uncovered': VerifyUncoveredPayload
  'gate-enrichment-stale': GateEnrichmentStalePayload
  'arc-verification-failed': ArcVerificationFailedPayload
  'env-incident': EnvIncidentPayload
  'dirty-integration': DirtyIntegrationPayload
}

export const REPRESENTATIVE_PAYLOADS: Record<keyof VerifyContracts, Record<string, unknown>> = {
  'verify-uncovered': {
    scope: 'orchestrator/src/core/queue.ts',
    changedPaths: ['orchestrator/src/core/queue.ts'],
    recipe: null,
    proposedGate: { name: 'lint', cmd: 'pnpm', args: ['run', 'lint'], scope: 'ui', evidence: 'package.json script "lint"' },
  },
  'gate-enrichment-stale': {
    signature: 'verify:build:tsc',
    passCount: 5,
    stepSpec: { name: 'tsc', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
  },
  'arc-verification-failed': {
    originId: 'mars-abc12345',
    findings: ['Goal "implement feature X" is not satisfied by merged output.'],
    landedCommits: ['a1b2c3d'],
  },
  'env-incident': {
    taskId: 'mars-abc12345',
    signature: 'ECONNRESET:npm-install',
    envRestartCount: 3,
  },
  'dirty-integration': {
    taskId: 'mars-abc12345',
    integrationBranch: 'main',
    dirtyPaths: ['orchestrator/src/core/queue.ts'],
    statusOutput: ' M orchestrator/src/core/queue.ts\n',
  },
}
