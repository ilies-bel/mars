import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent } from '@/shared/schemas'
import { ToolsCard } from './ToolsCard'

const minAgent = (overrides: Partial<Agent> = {}): Agent => ({
  name: 'Coder',
  role: 'implement',
  model: 'claude-sonnet-4-6',
  effort: null,
  permissionMode: null,
  allowedTools: ['Read', 'Write'],
  deniedTools: ['Bash'],
  messageCap: null,
  ...overrides,
})

describe('ToolsCard – type scale', () => {
  it('uses text-micro scale class instead of text-[10px]', () => {
    const html = renderToStaticMarkup(<ToolsCard agent={minAgent()} />)
    expect(html).toContain('text-micro')
    expect(html).not.toContain('text-[10px]')
  })

  it('uses text-meta scale class instead of text-[11px]', () => {
    const html = renderToStaticMarkup(<ToolsCard agent={minAgent()} />)
    expect(html).toContain('text-meta')
    expect(html).not.toContain('text-[11px]')
  })
})
