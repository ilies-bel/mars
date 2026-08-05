# Orchestrator test runner is vitest, invoked as 'npm test'

The orchestrator package's verify:test step and all developer-side test runs go through vitest (cd orchestrator && npm test, which resolves to 'vitest run'). Bun is the framework CLI runtime (per CLAUDE.md) but is never the test runner; 'bun test' is not supported by the orchestrator's test suite and will not be invoked by verify steps, scripts, or CI. Tasks whose verify lists tests must use 'npm test' (or 'npx vitest run …'), not 'bun test'.
