/**
 * AgentConfigPanel tests — pure-HTML assertions over `AgentConfigContent`
 * via renderToStaticMarkup (the drawer open/close is client-side state; the
 * observable server-renderable behaviour is the content body).
 */

import { describe, it, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentConfigContent } from './AgentConfigPanel'
import type { ChatConfig } from '@/shared/schemas'

const CONFIG: ChatConfig = {
  model: 'gpt-5.5',
  retentionMs: 300_000,
  minimumReusablePrefixTokens: 1024,
  contextWindowTokens: 200_000,
  systemPrompt: 'You are Mars.',
  systemPromptSource: 'built-in',
  builtinTools: [
    { name: 'shell', description: 'Run a shell command.' },
    { name: 'read_file', description: 'Read a file.' },
    { name: 'write_file', description: 'Write a file.' },
    { name: 'skill', description: 'Load a runbook.' },
  ],
  skills: [
    { name: 'diagnose', description: 'Diagnose a failed task.' },
    { name: 'task', description: 'Enqueue a task.' },
  ],
  mcpServers: [
    {
      name: 'codegraph',
      command: 'codegraph serve --mcp',
      status: 'connected',
      tools: [{ name: 'codegraph_explore', description: 'Explore the graph.' }],
    },
    { name: 'ghost', command: '/bin/ghost', status: 'failed', tools: [] },
  ],
}

describe('AgentConfigContent', () => {
  const html = renderToStaticMarkup(<AgentConfigContent config={CONFIG} />)

  it('renders the model', () => {
    expect(html).toContain('gpt-5.5')
  })

  it('renders the provider conversation-memory limits', () => {
    expect(html).toContain('5 min')
    expect(html).toContain('1,024 tokens')
    expect(html).toContain('200,000 tokens')
  })

  it('renders the system prompt with its source label', () => {
    expect(html).toContain('Built-in')
    expect(html).toContain('You are Mars.')
  })

  it('labels an override prompt with the override file path', () => {
    const overrideHtml = renderToStaticMarkup(
      <AgentConfigContent config={{ ...CONFIG, systemPromptSource: 'override' }} />,
    )
    expect(overrideHtml).toContain('.mars/chat-system-prompt.md')
  })

  it('lists every built-in tool with its description', () => {
    for (const t of CONFIG.builtinTools) {
      expect(html).toContain(t.name)
      expect(html).toContain(t.description)
    }
  })

  it('renders each MCP server with status, command, and tools', () => {
    expect(html).toContain('codegraph serve --mcp')
    expect(html).toContain('codegraph_explore')
    expect(html).toContain('aria-label="connected"')
  })

  it('marks a failed MCP server as not connected', () => {
    expect(html).toContain('not connected')
    expect(html).toContain('aria-label="failed"')
  })

  it('lists the skills with a count', () => {
    expect(html).toContain('2 skills')
    expect(html).toContain('Diagnose a failed task.')
  })

  it('shows an empty state when no MCP servers are configured', () => {
    const emptyHtml = renderToStaticMarkup(
      <AgentConfigContent config={{ ...CONFIG, mcpServers: [] }} />,
    )
    expect(emptyHtml).toContain('None configured')
  })
})
