import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  findDependencyRange,
  parseRange,
  parseUnsatisfiablePin,
  parseVersion,
  replaceDependencyRange,
  resolveManifestVersion,
} from '../baseline-version-resolver'

describe('parseUnsatisfiablePin', () => {
  it('parses the npm ETARGET/notarget failure, including a scoped package name', () => {
    const output = [
      'npm error code ETARGET',
      'npm error notarget No matching version found for @types/react-dom@^18.3.18.',
      'npm error notarget In most cases you or one of your dependencies are requesting',
      "npm error notarget a package version that doesn't exist.",
    ].join('\n')

    expect(parseUnsatisfiablePin(output)).toEqual({
      packageName: '@types/react-dom',
      range: '^18.3.18',
    })
  })

  it('parses the pnpm ERR_PNPM_NO_MATCHING_VERSION failure', () => {
    const output = ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for left-pad@^99.0.0'
    expect(parseUnsatisfiablePin(output)).toEqual({ packageName: 'left-pad', range: '^99.0.0' })
  })

  it('parses the yarn-classic failure', () => {
    const output = 'error Couldn\'t find any versions for "left-pad" that matches "^99.0.0"'
    expect(parseUnsatisfiablePin(output)).toEqual({ packageName: 'left-pad', range: '^99.0.0' })
  })

  it('returns null for an install failure that does not name an unsatisfiable pin', () => {
    const output = 'npm error code ENOTEMPTY\nnpm error syscall rmdir'
    expect(parseUnsatisfiablePin(output)).toBeNull()
  })
})

describe('parseVersion / compareVersions', () => {
  it('parses a bare version', () => {
    expect(parseVersion('18.3.5')).toEqual({ major: 18, minor: 3, patch: 5 })
  })

  it('returns null for a non-version string', () => {
    expect(parseVersion('latest')).toBeNull()
  })

  it('orders versions numerically, not lexically', () => {
    expect(compareVersions({ major: 18, minor: 3, patch: 9 }, { major: 18, minor: 3, patch: 10 })).toBeLessThan(0)
  })
})

describe('parseRange', () => {
  it('parses a caret range', () => {
    expect(parseRange('^18.3.18')).toEqual({ operator: '^', base: { major: 18, minor: 3, patch: 18 } })
  })

  it('parses a tilde range', () => {
    expect(parseRange('~1.2.3')).toEqual({ operator: '~', base: { major: 1, minor: 2, patch: 3 } })
  })

  it('parses an exact version as the empty operator', () => {
    expect(parseRange('1.2.3')).toEqual({ operator: '', base: { major: 1, minor: 2, patch: 3 } })
  })

  it('returns null for a non-semver range', () => {
    expect(parseRange('latest')).toBeNull()
  })
})

describe('resolveManifestVersion', () => {
  it('resolves to the sibling-pinned version when it is published — the incident scenario', () => {
    // packages/demo/package.json pinned ^18.3.18 (never published); four
    // sibling manifests already pinned ^18.3.5.
    const resolution = resolveManifestVersion({
      requestedRange: '^18.3.18',
      siblingRanges: ['^18.3.5', '^18.3.5', '^18.3.5'],
      publishedVersions: ['18.3.4', '18.3.5', '18.3.6'],
    })
    expect(resolution).toEqual({ status: 'resolved', range: '^18.3.5', source: 'sibling-pin' })
  })

  it('prefers the sibling pin over a numerically nearer published version', () => {
    // 18.3.17 is numerically closer to the request than the sibling pin
    // 18.3.5 is — the sibling pin must still win.
    const resolution = resolveManifestVersion({
      requestedRange: '^18.3.18',
      siblingRanges: ['^18.3.5'],
      publishedVersions: ['18.3.5', '18.3.17'],
    })
    expect(resolution).toEqual({ status: 'resolved', range: '^18.3.5', source: 'sibling-pin' })
  })

  it('falls back to the nearest published version when no sibling pin resolves', () => {
    const resolution = resolveManifestVersion({
      requestedRange: '^18.3.18',
      siblingRanges: ['^18.9.9'], // never published — must not be used
      publishedVersions: ['18.3.5', '18.3.6', '18.4.0'],
    })
    expect(resolution).toEqual({ status: 'resolved', range: '^18.3.6', source: 'nearest-published' })
  })

  it('breaks a nearest-published distance tie toward the lower version', () => {
    const resolution = resolveManifestVersion({
      requestedRange: '18.3.5',
      siblingRanges: [],
      publishedVersions: ['18.3.3', '18.3.7'], // both distance 2 from 18.3.5
    })
    expect(resolution).toEqual({ status: 'resolved', range: '18.3.3', source: 'nearest-published' })
  })

  it('escalates (unresolved) when there is no sibling pin and no published versions at all', () => {
    const resolution = resolveManifestVersion({
      requestedRange: '^18.3.18',
      siblingRanges: [],
      publishedVersions: [],
    })
    expect(resolution).toEqual({ status: 'unresolved' })
  })

  it('escalates (unresolved) when the requested range is not a parseable version, even with published data', () => {
    const resolution = resolveManifestVersion({
      requestedRange: 'latest',
      siblingRanges: [],
      publishedVersions: ['1.0.0', '2.0.0'],
    })
    expect(resolution).toEqual({ status: 'unresolved' })
  })
})

describe('findDependencyRange', () => {
  it('finds a pin in devDependencies', () => {
    const manifest = JSON.stringify({ devDependencies: { '@types/react-dom': '^18.3.18' } })
    expect(findDependencyRange(manifest, '@types/react-dom')).toBe('^18.3.18')
  })

  it('returns undefined when the package is not mentioned', () => {
    const manifest = JSON.stringify({ dependencies: { react: '^18.3.5' } })
    expect(findDependencyRange(manifest, '@types/react-dom')).toBeUndefined()
  })

  it('returns undefined for unparseable JSON', () => {
    expect(findDependencyRange('{not json', 'react')).toBeUndefined()
  })
})

describe('replaceDependencyRange', () => {
  it('rewrites only the targeted pin, preserving surrounding formatting', () => {
    const manifest = [
      '{',
      '  "name": "demo",',
      '  "devDependencies": {',
      '    "@types/react-dom": "^18.3.18",',
      '    "react": "^18.3.5"',
      '  }',
      '}',
      '',
    ].join('\n')
    const next = replaceDependencyRange(manifest, '@types/react-dom', '^18.3.18', '^18.3.5')
    expect(next).toContain('"@types/react-dom": "^18.3.5"')
    expect(next).toContain('"react": "^18.3.5"')
    expect(JSON.parse(next)).toEqual({
      name: 'demo',
      devDependencies: { '@types/react-dom': '^18.3.5', react: '^18.3.5' },
    })
  })

  it('throws when the exact pin is not present, rather than silently no-op-ing', () => {
    const manifest = JSON.stringify({ devDependencies: { react: '^18.3.5' } })
    expect(() => replaceDependencyRange(manifest, '@types/react-dom', '^18.3.18', '^18.3.5')).toThrow()
  })
})
