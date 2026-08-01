// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoticeMessage } from './NoticeMessage'

const mockInvokeAction = vi.fn().mockResolvedValue(undefined)
const mockAckNotice = vi.fn().mockResolvedValue(true)

vi.mock('@/shared/api', () => ({
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
}))

vi.mock('@/entities/notices', () => ({
  ackNotice: (...args: unknown[]) => mockAckNotice(...args),
}))

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('NoticeMessage', () => {
  it('runs the selected response before acknowledging the notice', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <NoticeMessage
          notice={{
            id: 'notice-1',
            body: 'The daemon needs restarting.',
            source: 'watchdog',
            createdAt: '2026-08-01T10:00:00.000Z',
            acknowledgedAt: null,
            preloadedResponses: [
              { op: 'restart', label: 'Restart task', entityId: 'task-1' },
              { op: 'dismiss', label: 'Dismiss', entityId: 'task-1' },
            ],
          }}
        />,
      )
    })

    expect(container.textContent).toContain('The daemon needs restarting.')
    const chips = container.querySelectorAll('button')
    expect(chips).toHaveLength(2)
    const chip = chips[0]
    expect(chip?.textContent).toBe('Restart task')

    await act(async () => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 'task-1')
    expect(mockAckNotice).toHaveBeenCalledWith('notice-1')
    expect(mockInvokeAction.mock.invocationCallOrder[0]).toBeLessThan(
      mockAckNotice.mock.invocationCallOrder[0]!,
    )
  })
})
