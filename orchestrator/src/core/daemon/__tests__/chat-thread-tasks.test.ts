import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type DbClient } from '../../lib/db.js'
import { linkTaskToThread, listTasksForThread } from '../chat-thread-tasks.js'

describe('chat thread task links', () => {
  let tempDir: string
  let client: DbClient

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mars-chat-thread-tasks-'))
    client = openDb(join(tempDir, 'state'))
  })

  afterEach(async () => {
    await client.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('keeps the two tasks created from a thread in creation order', async () => {
    await linkTaskToThread('thread-17', 'mars-11111111', client)
    await linkTaskToThread('thread-17', 'mars-22222222', client)

    expect((await listTasksForThread('thread-17', client)).map(({ taskId }) => taskId)).toEqual([
      'mars-11111111',
      'mars-22222222',
    ])
  })
})
