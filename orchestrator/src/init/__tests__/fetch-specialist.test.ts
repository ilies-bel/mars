import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchTreesIndex,
  parseFrontmatter,
  resolveSpecialist,
} from '../fetch-specialist'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(moduleDir, 'fixtures', 'nextjs-developer.md')

const makeResponse = (body: string, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 404,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  }) as unknown as Response

describe('parseFrontmatter', () => {
  it('parses real upstream specialist file', () => {
    const text = readFileSync(fixturePath, 'utf8')
    const parsed = parseFrontmatter(text)
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.frontmatter.name).toBe('nextjs-developer')
    expect(parsed.frontmatter.description.length).toBeGreaterThan(20)
    expect(parsed.frontmatter.tools.length).toBeGreaterThan(0)
    expect(parsed.body.length).toBeGreaterThan(100)
    expect(parsed.body.startsWith('---')).toBe(false)
  })

  it('returns null for non-frontmatter input', () => {
    expect(parseFrontmatter('hello world')).toBeNull()
    expect(parseFrontmatter('---\nincomplete')).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    const text = '---\nname: foo\n---\nbody\n'
    expect(parseFrontmatter(text)).toBeNull()
  })
})

describe('resolveSpecialist', () => {
  let cacheDir: string
  const origFetch = globalThis.fetch

  beforeEach(() => {
    cacheDir = mkdtempSync(resolve(tmpdir(), 'mars-cache-'))
  })

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true })
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('returns first matching slug as a hit', async () => {
    const fixture = readFileSync(fixturePath, 'utf8')
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.includes('/raw.githubusercontent.com/') && u.endsWith('nextjs-developer.md')) {
        return makeResponse(fixture)
      }
      return makeResponse('', false)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = new Map([
      ['nextjs-developer', 'content/02-language-specialists/nextjs-developer.md'],
      ['react-specialist', 'content/02-language-specialists/react-specialist.md'],
    ])
    const result = await resolveSpecialist(
      ['nextjs-developer', 'react-specialist'],
      index,
      { refresh: false, cacheDir },
    )
    expect(result.resolved).not.toBeNull()
    expect(result.resolved?.slug).toBe('nextjs-developer')
    expect(result.tried).toEqual(['nextjs-developer'])
  })

  it('skips slugs not in index and tries the next', async () => {
    const fixture = readFileSync(fixturePath, 'utf8')
    const fetchMock = vi.fn(async () => makeResponse(fixture))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = new Map([
      ['nextjs-developer', 'content/02-language-specialists/nextjs-developer.md'],
    ])
    const result = await resolveSpecialist(
      ['some-missing-slug', 'nextjs-developer'],
      index,
      { refresh: false, cacheDir },
    )
    expect(result.resolved?.slug).toBe('nextjs-developer')
    expect(result.tried).toEqual(['some-missing-slug', 'nextjs-developer'])
  })

  it('returns null with full tried list when no slug matches', async () => {
    const index = new Map<string, string>()
    const result = await resolveSpecialist(
      ['a', 'b', 'c'],
      index,
      { refresh: false, cacheDir },
    )
    expect(result.resolved).toBeNull()
    expect(result.tried).toEqual(['a', 'b', 'c'])
  })

  it('uses cached file on second call without hitting network', async () => {
    const fixture = readFileSync(fixturePath, 'utf8')
    const fetchMock = vi.fn(async () => makeResponse(fixture))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = new Map([
      ['nextjs-developer', 'content/02-language-specialists/nextjs-developer.md'],
    ])
    const opts = { refresh: false, cacheDir }
    const first = await resolveSpecialist(['nextjs-developer'], index, opts)
    expect(first.resolved).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = await resolveSpecialist(['nextjs-developer'], index, opts)
    expect(second.resolved).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refresh=true forces a re-fetch even when cache is fresh', async () => {
    const fixture = readFileSync(fixturePath, 'utf8')
    const fetchMock = vi.fn(async () => makeResponse(fixture))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = new Map([
      ['nextjs-developer', 'content/02-language-specialists/nextjs-developer.md'],
    ])
    await resolveSpecialist(['nextjs-developer'], index, { refresh: false, cacheDir })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await resolveSpecialist(['nextjs-developer'], index, { refresh: true, cacheDir })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to stale cache when network is down', async () => {
    const fixture = readFileSync(fixturePath, 'utf8')
    writeFileSync(resolve(cacheDir, 'nextjs-developer.md'), fixture, 'utf8')

    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = new Map([
      ['nextjs-developer', 'content/02-language-specialists/nextjs-developer.md'],
    ])
    const result = await resolveSpecialist(
      ['nextjs-developer'],
      index,
      { refresh: true, cacheDir },
    )
    expect(result.resolved).not.toBeNull()
    expect(result.resolved?.slug).toBe('nextjs-developer')
  })
})

describe('fetchTreesIndex', () => {
  let cacheDir: string
  const origFetch = globalThis.fetch

  beforeEach(() => {
    cacheDir = mkdtempSync(resolve(tmpdir(), 'mars-cache-'))
  })

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true })
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('builds a slug index from the github trees response', async () => {
    const treesPayload = JSON.stringify({
      tree: [
        {
          path: 'content/02-language-specialists/nextjs-developer.md',
          type: 'blob',
        },
        { path: 'content/01-core-development/frontend-developer.md', type: 'blob' },
        { path: 'README.md', type: 'blob' },
        { path: 'content/02-language-specialists', type: 'tree' },
      ],
    })
    const fetchMock = vi.fn(async () => makeResponse(treesPayload))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = await fetchTreesIndex({ refresh: false, cacheDir })
    expect(index.get('nextjs-developer')).toBe(
      'content/02-language-specialists/nextjs-developer.md',
    )
    expect(index.get('frontend-developer')).toBe(
      'content/01-core-development/frontend-developer.md',
    )
    expect(index.has('README')).toBe(false)
  })

  it('returns an empty map when network and cache are unavailable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const index = await fetchTreesIndex({ refresh: false, cacheDir })
    expect(index.size).toBe(0)
  })
})
