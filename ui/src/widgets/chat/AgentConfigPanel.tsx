/**
 * AgentConfigPanel — read-only view of the chat agent's effective
 * configuration, fetched from `GET /api/chat/config`: the model, the resolved
 * system prompt (built-in or `.mars/chat-system-prompt.md` override), the
 * built-in function tools, the skill index, and each MCP server from
 * `.mcp.json` with its connection status and contributed tools.
 *
 * `AgentConfigPanel` owns the trigger button (sidebar footer) and the drawer;
 * `AgentConfigContent` is the pure presentational body, exported for tests.
 * The config is fetched only while the drawer is open — opening it may spawn
 * the MCP servers on the daemon side if chat has not run yet.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Settings2Icon, XIcon } from 'lucide-react'
import { fetchChatConfig } from '@/shared/api'
import type { ChatConfig, ChatConfigTool } from '@/shared/schemas'

const SectionHeading = ({ children }: { children: string }) => (
  <h3 className="eyebrow mt-4 text-muted-foreground">{children}</h3>
)

const ToolList = ({ tools, testId }: { tools: ChatConfigTool[]; testId: string }) => (
  <ul data-testid={testId} className="mt-1 space-y-1.5">
    {tools.map((t) => (
      <li key={t.name} className="text-label">
        <span className="text-foreground">{t.name}</span>
        {t.description && <p className="mt-0.5 text-micro leading-snug text-muted-foreground">{t.description}</p>}
      </li>
    ))}
  </ul>
)

export const AgentConfigContent = ({ config }: { config: ChatConfig }) => (
  <div className="px-3 pb-4">
    <SectionHeading>Model</SectionHeading>
    <p data-testid="agent-config-model" className="mt-1 text-label text-foreground">{config.model}</p>

    <SectionHeading>Conversation memory</SectionHeading>
    <dl data-testid="agent-config-memory" className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-micro">
      <dt className="text-muted-foreground">Cache retention</dt>
      <dd>{Math.round(config.retentionMs / 60_000)} min</dd>
      <dt className="text-muted-foreground">Reusable prefix</dt>
      <dd>{config.minimumReusablePrefixTokens.toLocaleString()} tokens</dd>
      <dt className="text-muted-foreground">Context window</dt>
      <dd>{config.contextWindowTokens.toLocaleString()} tokens</dd>
    </dl>

    <SectionHeading>System prompt</SectionHeading>
    <details className="mt-1">
      <summary className="cursor-pointer text-label text-foreground hover:text-muted-foreground">
        {config.systemPromptSource === 'override'
          ? 'Override — .mars/chat-system-prompt.md'
          : 'Built-in'}
        <span className="ml-2 text-micro text-muted-foreground">({config.systemPrompt.length} chars)</span>
      </summary>
      <pre
        data-testid="agent-config-system-prompt"
        className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap border border-border bg-primary/5 p-2 font-mono text-micro leading-relaxed text-muted-foreground"
      >
        {config.systemPrompt}
      </pre>
    </details>

    <SectionHeading>Built-in tools</SectionHeading>
    <ToolList tools={config.builtinTools} testId="agent-config-builtin-tools" />

    <SectionHeading>MCP servers</SectionHeading>
    {config.mcpServers.length === 0 && (
      <p className="mt-1 text-micro text-muted-foreground">None configured (.mcp.json)</p>
    )}
    {config.mcpServers.map((server) => (
      <div key={server.name} data-testid={`agent-config-mcp-${server.name}`} className="mt-1.5">
        <p className="text-label text-foreground">
          <span
            aria-label={server.status}
            className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
              server.status === 'connected' ? 'bg-success' : 'bg-error'
            }`}
          />
          {server.name}
          <span className="ml-2 text-micro text-muted-foreground">{server.command}</span>
        </p>
        {server.status === 'failed' ? (
          <p className="mt-0.5 font-mono text-micro text-error">not connected</p>
        ) : (
          <div className="border-l border-border pl-2">
            <ToolList tools={server.tools} testId={`agent-config-mcp-tools-${server.name}`} />
          </div>
        )}
      </div>
    ))}

    <SectionHeading>Skills</SectionHeading>
    <details className="mt-1">
      <summary className="cursor-pointer text-label text-foreground hover:text-muted-foreground">
        {config.skills.length} skill{config.skills.length === 1 ? '' : 's'} (.claude/skills)
      </summary>
      <div className="border-l border-border pl-2">
        <ToolList tools={config.skills} testId="agent-config-skills" />
      </div>
    </details>
  </div>
)

export const AgentConfigPanel = ({ projectId }: { projectId?: string }) => {
  const [open, setOpen] = useState(false)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['chat-config', projectId],
    queryFn: () => fetchChatConfig(projectId),
    enabled: open,
  })

  return (
    <>
      <button
        type="button"
        data-testid="agent-config-trigger"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded border border-border px-2 py-1 font-mono text-label text-muted-foreground hover:bg-primary/20 hover:text-foreground"
      >
        <Settings2Icon className="h-3 w-3" />
        Agent config
      </button>

      {open && (
        <div
          data-testid="agent-config-panel"
          role="dialog"
          aria-label="Agent configuration"
          className="fixed inset-y-0 right-0 z-50 flex w-[380px] max-w-full flex-col border-l border-border bg-background shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="eyebrow text-muted-foreground">Agent configuration</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoading && <p className="px-3 py-4 text-label text-muted-foreground">Loading…</p>}
            {isError && (
              <p className="px-3 py-4 text-label text-error">
                Could not load the agent configuration — is the daemon running?
              </p>
            )}
            {data && <AgentConfigContent config={data} />}
          </div>
        </div>
      )}
    </>
  )
}
