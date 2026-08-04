import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeAllDbs, openDb, type DbClient } from '../db'
import { reserveAdrNumber } from '../adr-number-allocator'

let root = ''
let clients: DbClient[] = []

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()))
  clients = []
  await closeAllDbs()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const recordsDir = (): string => resolve(root, 'docs', 'adr')

const openClient = (target: string): DbClient => {
  const client = openDb(target)
  clients.push(client)
  return client
}

describe('reserveAdrNumber', () => {
  it('claims distinct numbers above existing records when callers reserve together', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'mars-adr-number-'))
    await mkdir(recordsDir(), { recursive: true })
    await writeFile(resolve(recordsDir(), '0007-existing.md'), '# Existing\n')

    const target = resolve(root, 'state')
    const [first, second] = await Promise.all([
      reserveAdrNumber(openClient(target), recordsDir()),
      reserveAdrNumber(openClient(target), recordsDir()),
    ])

    expect(new Set([first, second])).toEqual(new Set([8, 9]))
  })

  it('continues from the persisted counter when a new client starts after a restart', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'mars-adr-number-'))
    await mkdir(recordsDir(), { recursive: true })

    const target = resolve(root, 'state')
    const firstClient = openClient(target)
    expect(await reserveAdrNumber(firstClient, recordsDir())).toBe(1)
    await firstClient.close()
    clients.pop()

    expect(await reserveAdrNumber(openClient(target), recordsDir())).toBe(2)
  })
})
