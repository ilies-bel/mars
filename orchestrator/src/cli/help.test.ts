import { describe, expect, it } from 'vitest'
import { registry } from './commands'
import { renderCommandHelp, renderTopLevelHelp } from './help'

describe('CLI help', () => {
  it('renders every registered command from its own metadata', () => {
    for (const command of registry.values()) {
      const help = renderCommandHelp(registry, command)
      expect(help).toContain(command.usage.replace(/^usage:\s*/, ''))
      expect(help).toContain(command.summary)
    }
  })

  it('lists registered commands at the top level', () => {
    const help = renderTopLevelHelp(registry)

    expect(help).toContain('mars — provider-agnostic orchestrator')
    expect(help).toContain('task add')
    expect(help).toContain('workflow list')
  })

  it('renders command-owned flag descriptions', () => {
    const taskAdd = registry.get('task add')
    expect(taskAdd).toBeDefined()

    expect(renderCommandHelp(registry, taskAdd!)).toContain(
      'verification command run by the orchestrator',
    )
  })
})
