import { describe, it, expect } from 'vitest'
import { PROVIDERS } from '../providers'
import { PROVIDER_MODELS } from '../provider-types'
import { ASK_USER_DENIED_TOOL, WORKER_CONFIGS, READ_ONLY_DENIED_TOOLS, FIXER_BACKLOG_DENIED_TOOLS } from '../index'
import { type CliProviderDescriptor } from '../provider-registry'

// Type-narrowed CLI provider references for tests that exercise subprocess
// members (spawnArgv, feedPrompt, doneSignal). The three shipped providers are
// always CliProviderDescriptor; the casts are safe in this test context.
const CLAUDE_CLI = PROVIDERS.claude as CliProviderDescriptor
const GEMINI_CLI = PROVIDERS.gemini as CliProviderDescriptor
const CODEX_CLI = PROVIDERS.codex as CliProviderDescriptor

describe('PROVIDERS registry', () => {
  it('publishes conversation-memory facts for every provider model', () => {
    for (const provider of Object.values(PROVIDERS)) {
      for (const model of Object.values(PROVIDER_MODELS[provider.name])) {
        expect(provider.conversationMemory(model)).toMatchObject({
          retentionMs: expect.any(Number),
          minimumReusablePrefixTokens: expect.any(Number),
          contextWindowTokens: expect.any(Number),
        })
      }
    }
  })

  it('rejects an unknown model instead of borrowing another provider memory policy', () => {
    expect(() => PROVIDERS.codex.conversationMemory('claude-sonnet-5')).toThrow(
      "Provider 'codex' has no conversation-memory facts for model 'claude-sonnet-5'",
    )
  })

  it('declares provider-native model ids for every semantic tier', () => {
    expect(PROVIDER_MODELS.codex).toEqual({
      flagship: 'gpt-5.6-sol',
      balanced: 'gpt-5.6-terra',
      fast: 'gpt-5.6-luna',
    })
    expect(PROVIDER_MODELS.claude.flagship).toMatch(/^claude-/)
    expect(PROVIDER_MODELS.gemini.flagship).toMatch(/^gemini-/)
  })

  it("contains the 'claude' entry", () => {
    expect(Object.keys(PROVIDERS)).toContain('claude')
  })

  it("'claude' provider has a name matching its key", () => {
    expect(PROVIDERS.claude.name).toBe('claude')
  })

  it("'claude' provider spawnArgv starts with 'claude' and has no '-p' flag", () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv[0]).toBe('claude')
    expect(argv).not.toContain('-p')
  })

  it("'claude' provider spawnArgv includes '--model' when model is supplied", () => {
    const argv = CLAUDE_CLI.spawnArgv({ model: 'claude-sonnet-5' })
    expect(argv).toContain('--model')
    expect(argv).toContain('claude-sonnet-5')
  })

  it("'claude' provider spawnArgv omits '--model' when model is absent", () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).not.toContain('--model')
  })

  it("'claude' provider spawnArgv includes '--session-id' with a valid UUID when sessionId is supplied", () => {
    // Non-UUID task ids (e.g. "mars-abc123") must be converted to a valid UUID
    // because `claude --session-id` rejects non-UUID values.
    const argv = CLAUDE_CLI.spawnArgv({ sessionId: 'mars-abc123' })
    expect(argv).toContain('--session-id')
    const idx = (argv as readonly string[]).indexOf('--session-id')
    expect(argv[idx + 1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("'claude' provider spawnArgv passes a UUID sessionId through unchanged", () => {
    const uuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    const argv = CLAUDE_CLI.spawnArgv({ sessionId: uuid })
    expect(argv).toContain('--session-id')
    const idx = (argv as readonly string[]).indexOf('--session-id')
    expect(argv[idx + 1]).toBe(uuid)
  })

  it("'claude' provider spawnArgv omits '--session-id' when sessionId is absent", () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).not.toContain('--session-id')
  })

  it("'claude' provider feedPrompt writes the prompt body then the CR terminator", async () => {
    const written: string[] = []
    const fakePtyHandle = {
      write(data: string): void {
        written.push(data)
      },
    }

    await CLAUDE_CLI.feedPrompt(fakePtyHandle, 'hello world')

    expect(written).toHaveLength(2)
    expect(written[0]).toBe('hello world')
    expect(written[1]).toBe('\r')
  })

  it("'claude' provider doneSignal is a status-file signal with a wait function", () => {
    expect(CLAUDE_CLI.doneSignal).toBeDefined()
    expect(CLAUDE_CLI.doneSignal?.kind).toBe('status-file')
    expect(CLAUDE_CLI.doneSignal).toHaveProperty('wait')
    expect(typeof (CLAUDE_CLI.doneSignal as { wait?: unknown })?.wait).toBe('function')
  })

  it("contains the 'gemini' entry", () => {
    expect(Object.keys(PROVIDERS)).toContain('gemini')
  })

  it("'gemini' provider has a name matching its key", () => {
    expect(PROVIDERS.gemini.name).toBe('gemini')
  })

  it("'gemini' provider spawnArgv starts with 'gemini' and has no '-p' flag", () => {
    const argv = GEMINI_CLI.spawnArgv({})
    expect(argv[0]).toBe('gemini')
    expect(argv).not.toContain('-p')
  })

  it("'gemini' provider feedPrompt writes the prompt body then the CR terminator", async () => {
    const written: string[] = []
    const fakePtyHandle = {
      write(data: string): void {
        written.push(data)
      },
    }

    await GEMINI_CLI.feedPrompt(fakePtyHandle, 'do something')

    expect(written).toHaveLength(2)
    expect(written[0]).toBe('do something')
    expect(written[1]).toBe('\r')
  })

  it("'gemini' provider doneSignal is a prompt-scan signal with promptPrefix and spinnerOverride", () => {
    expect(GEMINI_CLI.doneSignal).toBeDefined()
    expect(GEMINI_CLI.doneSignal?.kind).toBe('prompt-scan')
    const signal = GEMINI_CLI.doneSignal as { kind: string; promptPrefix?: unknown; spinnerOverride?: unknown }
    expect(typeof signal.promptPrefix).toBe('string')
    expect(signal.promptPrefix).toBeTruthy()
    expect(signal.spinnerOverride).toBeInstanceOf(RegExp)
  })

  it("contains the 'codex' entry", () => {
    expect(Object.keys(PROVIDERS)).toContain('codex')
  })

  it("'codex' provider has a name matching its key", () => {
    expect(PROVIDERS.codex.name).toBe('codex')
  })

  it("'codex' provider spawnArgv starts with 'codex' and has no '-p' flag", () => {
    const argv = CODEX_CLI.spawnArgv({})
    expect(argv[0]).toBe('codex')
    expect(argv).not.toContain('-p')
  })

  it("'codex' provider spawnArgv includes '--model' when model is supplied", () => {
    const argv = CODEX_CLI.spawnArgv({ model: 'o4-mini' })
    expect(argv).toContain('--model')
    expect(argv).toContain('o4-mini')
  })

  it("'codex' provider spawnArgv omits '--model' when model is absent", () => {
    const argv = CODEX_CLI.spawnArgv({})
    expect(argv).not.toContain('--model')
  })

  it("'codex' provider feedPrompt writes the prompt body then the CR terminator", async () => {
    const written: string[] = []
    const fakePtyHandle = {
      write(data: string): void {
        written.push(data)
      },
    }

    await CODEX_CLI.feedPrompt(fakePtyHandle, 'build this feature')

    expect(written).toHaveLength(2)
    expect(written[0]).toBe('build this feature')
    expect(written[1]).toBe('\r')
  })

  it("'codex' provider doneSignal is a prompt-scan signal with promptPrefix 'codex>' and spinnerOverride regex", () => {
    expect(CODEX_CLI.doneSignal).toBeDefined()
    expect(CODEX_CLI.doneSignal?.kind).toBe('prompt-scan')
    const signal = CODEX_CLI.doneSignal as { kind: string; promptPrefix?: unknown; spinnerOverride?: unknown }
    expect(signal.promptPrefix).toBe('codex>')
    expect(signal.spinnerOverride).toBeInstanceOf(RegExp)
  })

  it("'codex' doneSignal spinnerOverride matches all braille spinner characters followed by space and text", () => {
    const ds = CODEX_CLI.doneSignal as { kind: string; spinnerOverride: RegExp }
    for (const spinner of ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']) {
      expect(ds.spinnerOverride.test(`${spinner} processing...`)).toBe(true)
    }
  })
})

describe("PROVIDERS.gemini headless adapter", () => {
  it("exists and exposes a 'run' function", () => {
    expect(PROVIDERS.gemini.headless).toBeDefined()
    expect(typeof PROVIDERS.gemini.headless.run).toBe('function')
  })

  it("capabilities has usageSemantics: 'none', quotaRejected: false, sessionId: false", () => {
    const { capabilities } = PROVIDERS.gemini.headless
    expect(capabilities.usageSemantics).toBe('none')
    expect(capabilities.quotaRejected).toBe(false)
    expect(capabilities.sessionId).toBe(false)
  })
})

describe("PROVIDERS.claude headless adapter", () => {
  it("exists and exposes a 'run' function", () => {
    expect(PROVIDERS.claude.headless).toBeDefined()
    expect(typeof PROVIDERS.claude.headless.run).toBe('function')
  })

  it("capabilities has usageSemantics: 'per-request', quotaRejected: true, sessionId: true", () => {
    const { capabilities } = PROVIDERS.claude.headless
    expect(capabilities.usageSemantics).toBe('per-request')
    expect(capabilities.quotaRejected).toBe(true)
    expect(capabilities.sessionId).toBe(true)
  })
})

describe('WORKER_CONFIGS provider field', () => {
  const workerNames = Object.keys(WORKER_CONFIGS) as Array<keyof typeof WORKER_CONFIGS>

  it('every built-in Worker declares a provider', () => {
    for (const name of workerNames) {
      expect(WORKER_CONFIGS[name]).toHaveProperty('provider')
    }
  })

  it('every built-in Worker provider resolves to a known PROVIDERS entry', () => {
    for (const name of workerNames) {
      const { provider } = WORKER_CONFIGS[name]
      expect(
        PROVIDERS,
        `Worker ${name} has provider '${provider}' which is not in PROVIDERS`,
      ).toHaveProperty(provider)
    }
  })

  it('all Workers are un-pinned: every one inherits the same resolved default provider', () => {
    // Reflector (9th) added when lib/reflector.ts moved onto the Worker layer;
    // update this count if more workers are added.
    expect(workerNames).toHaveLength(9)
    // Deliberately does not assert which provider is active — `defaultProvider`
    // in .mars/daemon.json is a legitimate, machine-local operator setting
    // (see resolveWorkerProvider in providers.ts). The invariant under test is
    // that no built-in Worker carries its own provider pin: they all resolve
    // to whatever the ambient default is, so they share exactly one provider
    // and their models all come from that provider's own model table.
    const providers = new Set(workerNames.map((name) => WORKER_CONFIGS[name].provider))
    expect(providers.size).toBe(1)
    const [resolvedProvider] = [...providers]

    const modelPatternByProvider: Record<string, RegExp> = {
      codex: /^gpt-5\.6-/,
      claude: /^claude-/,
      gemini: /^gemini-/,
    }
    const pattern = modelPatternByProvider[resolvedProvider]
    expect(pattern, `no known model pattern for provider '${resolvedProvider}'`).toBeDefined()

    for (const name of workerNames) {
      expect(WORKER_CONFIGS[name].provider).toBe(resolvedProvider)
      expect(WORKER_CONFIGS[name].model).toMatch(pattern)
    }
  })
})

describe("'claude' provider spawnArgv — security posture flags", () => {
  it('always includes --disallowedTools with agent-to-user denied tools even when no disallowedTools are passed', () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).toContain('--disallowedTools')
    const idx = (argv as readonly string[]).indexOf('--disallowedTools')
    const tools = (argv[idx + 1] ?? '').split(',')
    expect(tools).toContain('AskUserQuestion')
    expect(tools).toContain('SendUserMessage')
  })

  it('merges caller disallowedTools with the agent-to-user denial so both survive', () => {
    const argv = CLAUDE_CLI.spawnArgv({ disallowedTools: ['Edit', 'Write'] })
    const idx = (argv as readonly string[]).indexOf('--disallowedTools')
    const tools = (argv[idx + 1] ?? '').split(',')
    expect(tools).toContain('AskUserQuestion')
    expect(tools).toContain('SendUserMessage')
    expect(tools).toContain('Edit')
    expect(tools).toContain('Write')
  })

  it("emits '--dangerously-skip-permissions' for permissionMode 'bypassPermissions'", () => {
    const argv = CLAUDE_CLI.spawnArgv({ permissionMode: 'bypassPermissions' })
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv).not.toContain('--permission-mode')
  })

  it("emits '--permission-mode default' for permissionMode 'default'", () => {
    const argv = CLAUDE_CLI.spawnArgv({ permissionMode: 'default' })
    expect(argv).toContain('--permission-mode')
    const idx = (argv as readonly string[]).indexOf('--permission-mode')
    expect(argv[idx + 1]).toBe('default')
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it('omits permission-mode flags entirely when permissionMode is absent', () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).not.toContain('--permission-mode')
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it("emits '--effort high' when effort is 'high'", () => {
    const argv = CLAUDE_CLI.spawnArgv({ effort: 'high' })
    expect(argv).toContain('--effort')
    const idx = (argv as readonly string[]).indexOf('--effort')
    expect(argv[idx + 1]).toBe('high')
  })

  it("omits '--effort' when effort is absent", () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).not.toContain('--effort')
  })

  it("emits '--agent <name>' when agent is set", () => {
    const argv = CLAUDE_CLI.spawnArgv({ agent: 'my-agent' })
    expect(argv).toContain('--agent')
    const idx = (argv as readonly string[]).indexOf('--agent')
    expect(argv[idx + 1]).toBe('my-agent')
  })

  it("omits '--agent' when agent is absent", () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).not.toContain('--agent')
  })

  it("emits '--append-system-prompt <text>' when appendSystemPrompt is set", () => {
    const argv = CLAUDE_CLI.spawnArgv({ appendSystemPrompt: 'Use rg not grep.' })
    expect(argv).toContain('--append-system-prompt')
    const idx = (argv as readonly string[]).indexOf('--append-system-prompt')
    expect(argv[idx + 1]).toBe('Use rg not grep.')
  })

  it("omits '--append-system-prompt' when appendSystemPrompt is absent", () => {
    const argv = CLAUDE_CLI.spawnArgv({})
    expect(argv).not.toContain('--append-system-prompt')
  })
})

describe('pty Worker spawnArgv — security posture (integration with WORKER_CONFIGS)', () => {
  it('Planner-like pty Worker produces --permission-mode default and denied tools including READ_ONLY_DENIED_TOOLS and agent-to-user denial', () => {
    // Simulate what buildWorker forwards from a Planner-like pty config
    const cfg = WORKER_CONFIGS.Planner
    const argv = CLAUDE_CLI.spawnArgv({
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      effort: cfg.effort,
      disallowedTools: cfg.disallowedTools,
      agent: cfg.agent,
      appendSystemPrompt: cfg.appendSystemPrompt,
    })

    // Permission posture: default (not bypassPermissions)
    expect(argv).toContain('--permission-mode')
    const pmIdx = (argv as readonly string[]).indexOf('--permission-mode')
    expect(argv[pmIdx + 1]).toBe('default')
    expect(argv).not.toContain('--dangerously-skip-permissions')

    // Denied tools: READ_ONLY_DENIED_TOOLS union agent-to-user denial
    expect(argv).toContain('--disallowedTools')
    const dtIdx = (argv as readonly string[]).indexOf('--disallowedTools')
    const tools = (argv[dtIdx + 1] ?? '').split(',')
    for (const t of READ_ONLY_DENIED_TOOLS) expect(tools).toContain(t)
    expect(tools).toContain('AskUserQuestion')
    expect(tools).toContain('SendUserMessage')
  })

  it('Fixer-like pty Worker produces --dangerously-skip-permissions and FIXER_BACKLOG_DENIED_TOOLS union agent-to-user denial', () => {
    const cfg = WORKER_CONFIGS.Fixer
    const argv = CLAUDE_CLI.spawnArgv({
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      effort: cfg.effort,
      disallowedTools: cfg.disallowedTools,
    })

    // Permission posture: bypassPermissions → --dangerously-skip-permissions
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv).not.toContain('--permission-mode')

    // Denied tools: FIXER_BACKLOG_DENIED_TOOLS union agent-to-user denial
    expect(argv).toContain('--disallowedTools')
    const dtIdx = (argv as readonly string[]).indexOf('--disallowedTools')
    const tools = (argv[dtIdx + 1] ?? '').split(',')
    for (const t of FIXER_BACKLOG_DENIED_TOOLS) expect(tools).toContain(t)
    expect(tools).toContain('AskUserQuestion')
    expect(tools).toContain('SendUserMessage')
  })
})

describe("ask-user tool policy — spawnArgv propagation", () => {
  // The ASK_USER_DENIED_TOOL bash pattern must reach the running claude subprocess
  // via --disallowedTools for read-only workers, and must NOT appear for Coder/Fixer.

  it('Planner-like spawnArgv includes ASK_USER_DENIED_TOOL in --disallowedTools', () => {
    const cfg = WORKER_CONFIGS.Planner
    const argv = CLAUDE_CLI.spawnArgv({
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      effort: cfg.effort,
      disallowedTools: cfg.disallowedTools,
    })
    expect(argv).toContain('--disallowedTools')
    const idx = (argv as readonly string[]).indexOf('--disallowedTools')
    const tools = (argv[idx + 1] ?? '').split(',')
    expect(tools).toContain(ASK_USER_DENIED_TOOL)
  })

  it('Coder-like spawnArgv does NOT include ASK_USER_DENIED_TOOL in --disallowedTools', () => {
    const cfg = WORKER_CONFIGS.Coder
    const argv = CLAUDE_CLI.spawnArgv({
      model: cfg.model,
      permissionMode: cfg.permissionMode,
      effort: cfg.effort,
      disallowedTools: cfg.disallowedTools,
    })
    expect(argv).toContain('--disallowedTools')
    const idx = (argv as readonly string[]).indexOf('--disallowedTools')
    const tools = (argv[idx + 1] ?? '').split(',')
    expect(tools).not.toContain(ASK_USER_DENIED_TOOL)
  })

  it('READ_ONLY_DENIED_TOOLS contains ASK_USER_DENIED_TOOL so all read-only workers inherit the denial', () => {
    // This is the structural guarantee: adding ASK_USER_DENIED_TOOL to
    // READ_ONLY_DENIED_TOOLS means every worker that references that constant
    // in its disallowedTools config automatically gets the denial.
    expect(READ_ONLY_DENIED_TOOLS).toContain(ASK_USER_DENIED_TOOL)
  })
})
