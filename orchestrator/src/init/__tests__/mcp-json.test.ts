/**
 * Acceptance tests for .mcp.json scaffolding via `mars init` / `mars update`.
 *
 * Acceptance criteria:
 * (a) fresh write when .mcp.json is absent
 * (b) merge preserves an existing unrelated server
 * (c) stale codegraph entry is overwritten with the canonical template value
 * (d) malformed JSON fails loudly with a clear error message
 * (e) idempotency: second apply produces no diff
 * (f) missing mcpServers key is created
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeMcpJson } from '../scaffold'

describe('mergeMcpJson', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-mcp-json-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('(a) writes .mcp.json with codegraph entry when no file exists', () => {
    mergeMcpJson(root)

    const parsed = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'))
    expect(parsed.mcpServers.codegraph).toEqual({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
    })
  })

  it('(b) preserves an existing unrelated server when merging', () => {
    writeFileSync(
      resolve(root, '.mcp.json'),
      JSON.stringify(
        { mcpServers: { myServer: { type: 'stdio', command: 'my-server', args: [] } } },
        null,
        2,
      ) + '\n',
    )

    mergeMcpJson(root)

    const parsed = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'))
    expect(parsed.mcpServers.myServer).toEqual({
      type: 'stdio',
      command: 'my-server',
      args: [],
    })
    expect(parsed.mcpServers.codegraph).toEqual({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
    })
  })

  it('(c) overwrites a stale codegraph entry with the canonical template value', () => {
    writeFileSync(
      resolve(root, '.mcp.json'),
      JSON.stringify(
        { mcpServers: { codegraph: { type: 'stdio', command: 'old-codegraph', args: ['--old'] } } },
        null,
        2,
      ) + '\n',
    )

    mergeMcpJson(root)

    const parsed = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'))
    expect(parsed.mcpServers.codegraph).toEqual({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
    })
  })

  it('(d) throws a clear error when the existing .mcp.json is malformed JSON', () => {
    writeFileSync(resolve(root, '.mcp.json'), '{ not valid json }')

    expect(() => mergeMcpJson(root)).toThrow('.mcp.json')
  })

  it('(e) is idempotent: running twice produces no diff', () => {
    mergeMcpJson(root)
    const first = readFileSync(resolve(root, '.mcp.json'), 'utf8')

    mergeMcpJson(root)
    const second = readFileSync(resolve(root, '.mcp.json'), 'utf8')

    expect(second).toBe(first)
  })

  it('(e) is idempotent when merging with an existing unrelated server', () => {
    writeFileSync(
      resolve(root, '.mcp.json'),
      JSON.stringify(
        { mcpServers: { otherServer: { type: 'stdio', command: 'other', args: [] } } },
        null,
        2,
      ) + '\n',
    )

    mergeMcpJson(root)
    const first = readFileSync(resolve(root, '.mcp.json'), 'utf8')

    mergeMcpJson(root)
    const second = readFileSync(resolve(root, '.mcp.json'), 'utf8')

    expect(second).toBe(first)
  })

  it('(f) creates the mcpServers key when existing .mcp.json has none', () => {
    writeFileSync(
      resolve(root, '.mcp.json'),
      JSON.stringify({ someKey: 'someValue' }, null, 2) + '\n',
    )

    mergeMcpJson(root)

    const parsed = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'))
    expect(parsed.someKey).toBe('someValue')
    expect(parsed.mcpServers.codegraph).toEqual({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
    })
  })
})
