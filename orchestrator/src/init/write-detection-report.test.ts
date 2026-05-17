import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeDetectionReport } from './write-detection-report'

describe('writeDetectionReport', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-detect-report-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a two-space-indented JSON file with manifests and warnings', () => {
    const reportPath = resolve(root, '.mars', 'supervisors', 'detection-report.json')

    const result = writeDetectionReport({
      reportPath,
      manifests: [
        {
          dir: '.',
          techs: ['javascript', 'typescript'],
          supervisors: ['node-backend-supervisor'],
        },
        {
          dir: 'frontend',
          techs: ['react'],
          supervisors: ['react-supervisor'],
        },
      ],
      warnings: [{ kind: 'depth-cap', paths: ['deep/nested/path'] }],
    })

    expect(result.status).toBe('ok')

    const raw = readFileSync(reportPath, 'utf8')
    expect(raw).toBe(
      `{
  "manifests": [
    {
      "path": ".",
      "techs": [
        "javascript",
        "typescript"
      ],
      "supervisors": [
        "node-backend-supervisor"
      ]
    },
    {
      "path": "frontend",
      "techs": [
        "react"
      ],
      "supervisors": [
        "react-supervisor"
      ]
    }
  ],
  "warnings": [
    {
      "kind": "depth-cap",
      "paths": [
        "deep/nested/path"
      ]
    }
  ]
}
`,
    )
  })

  it('creates the supervisors directory if missing', () => {
    const reportPath = resolve(root, '.mars', 'supervisors', 'detection-report.json')

    const result = writeDetectionReport({
      reportPath,
      manifests: [],
      warnings: [],
    })

    expect(result.status).toBe('ok')
    const raw = readFileSync(reportPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed).toEqual({ manifests: [], warnings: [] })
  })

  it('omits supervisor and inputs to make manifests entries hold only path, techs, supervisors', () => {
    const reportPath = resolve(root, 'detection-report.json')

    writeDetectionReport({
      reportPath,
      manifests: [
        {
          dir: 'svc/api',
          techs: ['go'],
          supervisors: ['go-supervisor'],
        },
      ],
      warnings: [],
    })

    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      manifests: Array<Record<string, unknown>>
    }
    expect(parsed.manifests).toHaveLength(1)
    expect(Object.keys(parsed.manifests[0]).sort()).toEqual([
      'path',
      'supervisors',
      'techs',
    ])
  })

  it('overwrites a prior report on re-run (no append, no timestamping)', () => {
    const reportPath = resolve(root, 'detection-report.json')

    writeDetectionReport({
      reportPath,
      manifests: [
        { dir: '.', techs: ['python'], supervisors: ['python-backend-supervisor'] },
      ],
      warnings: [],
    })

    writeDetectionReport({
      reportPath,
      manifests: [{ dir: '.', techs: ['rust'], supervisors: ['rust-supervisor'] }],
      warnings: [],
    })

    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      manifests: Array<{ path: string; techs: string[]; supervisors: string[] }>
    }
    expect(parsed.manifests).toEqual([
      { path: '.', techs: ['rust'], supervisors: ['rust-supervisor'] },
    ])
  })

  it('returns an error result when the report path is unwritable', () => {
    // Pre-create the report path as a directory so writeFileSync fails with EISDIR.
    const reportPath = resolve(root, 'detection-report.json')
    mkdirSync(reportPath, { recursive: true })

    const result = writeDetectionReport({
      reportPath,
      manifests: [],
      warnings: [],
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(typeof result.error).toBe('string')
    }
  })
})
