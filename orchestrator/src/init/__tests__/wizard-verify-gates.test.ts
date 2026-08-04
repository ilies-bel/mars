import { describe, expect, it } from 'vitest'
import { runInitWizard, type LineReader } from '../wizard-controller'

const detectedGates = [
  {
    scope: 'orchestrator',
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
    required: true,
    tier: 'task' as const,
    source: 'detected',
  },
]

describe('onboarding verify gates', () => {
  it('shows detected gates and accepts them unchanged when Enter is pressed', async () => {
    const asked: string[] = []
    const answers = ['']
    const readLine: LineReader = (question) => {
      asked.push(question)
      return Promise.resolve(answers.shift() ?? '')
    }

    const choices = await runInitWizard({
      isTTY: true,
      flags: { '--register-project': true },
      force: false,
      detectedGates,
      readLine,
    })

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('orchestrator')
    expect(asked[0]).toContain('typecheck')
    expect(asked[0]).toContain('npx')
    expect(asked[0]).toContain('task')
    expect(asked[0]).toContain('true')
    expect(asked[0]).toContain('[Enter=accept, e=edit]')
    expect(choices.verifyGates).toEqual(detectedGates)
  })

  it('validates an edited JSON array and redisplays its normalized confirmation', async () => {
    const asked: string[] = []
    const answers = [
      'e',
      JSON.stringify([
        {
          scope: ' ui ',
          name: 'lint',
          cmd: ' npm ',
          args: ['run', 'lint'],
          required: false,
          tier: 'integration',
        },
      ]),
      '',
    ]
    const readLine: LineReader = (question) => {
      asked.push(question)
      return Promise.resolve(answers.shift() ?? '')
    }

    const choices = await runInitWizard({
      isTTY: true,
      flags: { '--register-project': true },
      force: false,
      detectedGates,
      readLine,
    })

    expect(choices.verifyGates).toEqual([
      {
        scope: 'ui',
        name: 'lint',
        cmd: 'npm',
        args: ['run', 'lint'],
        required: false,
        tier: 'integration',
        source: 'detected',
      },
    ])
    expect(asked[2]).toContain('"scope": "ui"')
    expect(asked[2]).toContain('[Enter=accept, e=edit]')
  })

  it('reports invalid edits and retries without accepting a partial set', async () => {
    const asked: string[] = []
    const answers = [
      'e',
      '[{"scope":".","name":"test","cmd":"npm","args":[],"required":true,"tier":"invalid"}]',
      'e',
      '[]',
      '',
    ]
    const readLine: LineReader = (question) => {
      asked.push(question)
      return Promise.resolve(answers.shift() ?? '')
    }

    const choices = await runInitWizard({
      isTTY: true,
      flags: { '--register-project': true },
      force: false,
      detectedGates,
      readLine,
    })

    expect(asked.some((question) => question.includes('Invalid verify gate list'))).toBe(true)
    expect(choices.verifyGates).toEqual([])
  })

  it('accepts matching flag and config overrides without prompting', async () => {
    const override = [
      {
        scope: '.',
        name: 'test',
        cmd: 'npm',
        args: ['test'],
        required: true,
        tier: 'task' as const,
      },
    ]
    const neverRead: LineReader = () => {
      throw new Error('scripted gate overrides must not prompt')
    }

    const fromFlag = await runInitWizard({
      isTTY: false,
      flags: {
        '--register-project': true,
        '--verify-gates-json': JSON.stringify(override),
      },
      force: false,
      detectedGates,
      readLine: neverRead,
    })
    const fromConfig = await runInitWizard({
      isTTY: false,
      flags: { '--register-project': true },
      config: { verifyGates: override },
      force: false,
      detectedGates,
      readLine: neverRead,
    })

    expect(fromFlag.verifyGates).toEqual(fromConfig.verifyGates)
    expect(fromFlag.verifyGates).toEqual([
      { ...override[0], source: 'detected' },
    ])
  })
})
