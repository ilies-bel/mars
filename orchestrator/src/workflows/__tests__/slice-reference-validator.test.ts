import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { validateSliceReferences } from '../slice-reference-validator'

// Worktree root: four levels up from __tests__/
const REPO_ROOT = resolve(__dirname, '../../../..')

describe('validateSliceReferences', () => {
  it('(a) a slice with only real refs → both arrays empty', () => {
    // `loadWorkflowByName` is exported from queue-workflow-store.ts
    const result = validateSliceReferences(
      {
        prescriptiveAction:
          'Call `loadWorkflowByName` to retrieve the workflow definition.',
        readFirst: ['orchestrator/src/workflows/queue-workflow-store.ts'],
      },
      REPO_ROOT,
    )
    expect(result.missingSymbols).toEqual([])
    expect(result.missingReadFirstPaths).toEqual([])
  })

  it('(b) a slice citing `loadWorkflowForKind` → present in missingSymbols', () => {
    // `loadWorkflowForKind` does not exist anywhere in the repo
    const result = validateSliceReferences(
      {
        prescriptiveAction:
          'Call `loadWorkflowForKind` to retrieve the workflow definition.',
        readFirst: ['orchestrator/src/workflows/queue-workflow-store.ts'],
      },
      REPO_ROOT,
    )
    expect(result.missingSymbols).toContain('loadWorkflowForKind')
    expect(result.missingReadFirstPaths).toEqual([])
  })

  it('(c) a slice with a fabricated readFirst path → present in missingReadFirstPaths', () => {
    // The test file `load-workflow-strict.test.ts` does not exist on disk
    const result = validateSliceReferences(
      {
        prescriptiveAction:
          'Call `loadWorkflowByName` to retrieve the workflow definition.',
        readFirst: [
          'orchestrator/src/workflows/__tests__/load-workflow-strict.test.ts',
        ],
      },
      REPO_ROOT,
    )
    expect(result.missingSymbols).toEqual([])
    expect(result.missingReadFirstPaths).toContain(
      'orchestrator/src/workflows/__tests__/load-workflow-strict.test.ts',
    )
  })

  it('(d) empty prescriptiveAction and empty readFirst → both arrays empty', () => {
    const result = validateSliceReferences(
      {
        prescriptiveAction: '',
        readFirst: [],
      },
      REPO_ROOT,
    )
    expect(result.missingSymbols).toEqual([])
    expect(result.missingReadFirstPaths).toEqual([])
  })
})
