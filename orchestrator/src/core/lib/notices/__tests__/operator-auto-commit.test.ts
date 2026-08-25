/**
 * The auto-commit Notice has one job: make a commit the operator did not ask
 * for findable and stoppable. So the two things pinned here are the sha
 * reaching the payload and the sentence saying what to reply to stop it.
 */
import { describe, expect, it } from 'vitest'

import { speakOperatorAutoCommitNotice } from '../operator-auto-commit.js'
import {
  offersForConversationNotice,
  renderConversationNotice,
} from '../../conversation-copy.js'
import type { postConversationNotice } from '../../conversation-delivery.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('speakOperatorAutoCommitNotice', () => {
  it('posts the commit sha and the paths it swept, urgently', async () => {
    const posted: Parameters<typeof postConversationNotice>[0][] = []
    const post: typeof postConversationNotice = async (input) => {
      posted.push(input)
      return { id: 'notice-1', delivered: true }
    }

    await speakOperatorAutoCommitNotice(
      {
        taskId: 'mars-abc123',
        branch: 'main',
        commitSha: SHA,
        files: ['operator.txt', 'notes.md'],
      },
      post,
    )

    expect(posted).toHaveLength(1)
    const notice = posted[0]
    expect(notice).toMatchObject({
      kind: 'merge.operator-auto-commit',
      priority: 'urgent',
      payload: { taskId: 'mars-abc123', branch: 'main', commitSha: SHA, files: ['operator.txt', 'notes.md'] },
    })
  })
})

describe('the auto-commit Notice copy', () => {
  it('names the commit and says what to reply to turn the automation off', () => {
    const body = renderConversationNotice('merge.operator-auto-commit', {
      taskId: 'mars-abc123',
      branch: 'main',
      commitSha: SHA,
      files: ['operator.txt', 'notes.md'],
    })

    expect(body).toContain(SHA.slice(0, 9))
    expect(body).toContain('mars-abc123')
    expect(body).toContain('stop auto-committing')

    // And the reply it names is the same vocabulary the Offer chip carries,
    // so free text and the tap resolve to the same thing.
    const labels = offersForConversationNotice('merge.operator-auto-commit', {
      taskId: 'mars-abc123',
      branch: 'main',
      commitSha: SHA,
      files: ['operator.txt', 'notes.md'],
    }).map((offer) => offer.label.toLowerCase())
    expect(labels).toContain('stop auto-committing')
  })
})
