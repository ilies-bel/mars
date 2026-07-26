import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DeployConfigError, loadDeployConfig } from '../config'

const makeTempDir = (): string => mkdtempSync(resolve(tmpdir(), 'mars-deploy-config-test-'))

describe('loadDeployConfig', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('throws DeployConfigError with "deploy config not found at <path>" when the file is missing', async () => {
    const expectedPath = join(stateDir, 'deploy.config.json')
    await expect(loadDeployConfig(stateDir)).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DeployConfigError &&
        err.message === `deploy config not found at ${expectedPath}`
      )
    })
  })

  it('throws DeployConfigError wrapping the parse error when the file contains invalid JSON', async () => {
    writeFileSync(join(stateDir, 'deploy.config.json'), '{ not valid json }', 'utf8')
    await expect(loadDeployConfig(stateDir)).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeployConfigError && err.cause instanceof SyntaxError
    })
  })

  it('throws DeployConfigError when provider is missing', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ env: { FOO: 'bar' } }),
      'utf8',
    )
    await expect(loadDeployConfig(stateDir)).rejects.toBeInstanceOf(DeployConfigError)
  })

  it('throws DeployConfigError when provider is an empty string', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ provider: '' }),
      'utf8',
    )
    await expect(loadDeployConfig(stateDir)).rejects.toBeInstanceOf(DeployConfigError)
  })

  it('throws DeployConfigError when an unknown top-level key is present', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ provider: 'fly', unknownKey: 'oops' }),
      'utf8',
    )
    await expect(loadDeployConfig(stateDir)).rejects.toBeInstanceOf(DeployConfigError)
  })

  it('returns the parsed config with env keys/values on a valid file', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ provider: 'fly', env: { PORT: '3000', NODE_ENV: 'production' } }),
      'utf8',
    )
    const config = await loadDeployConfig(stateDir)
    expect(config.provider).toBe('fly')
    expect(config.env['PORT']).toBe('3000')
    expect(config.env['NODE_ENV']).toBe('production')
  })

  it('defaults env to an empty object when omitted', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ provider: 'render' }),
      'utf8',
    )
    const config = await loadDeployConfig(stateDir)
    expect(config.env).toEqual({})
  })

  it('returns secretsFrom when present', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ provider: 'fly', secretsFrom: 'op://vault/item' }),
      'utf8',
    )
    const config = await loadDeployConfig(stateDir)
    expect(config.secretsFrom).toBe('op://vault/item')
  })

  it('leaves secretsFrom undefined when omitted', async () => {
    writeFileSync(
      join(stateDir, 'deploy.config.json'),
      JSON.stringify({ provider: 'fly' }),
      'utf8',
    )
    const config = await loadDeployConfig(stateDir)
    expect(config.secretsFrom).toBeUndefined()
  })
})

describe('DeployConfigError', () => {
  it('is an instance of Error', () => {
    const err = new DeployConfigError('test')
    expect(err).toBeInstanceOf(Error)
  })

  it('has name "DeployConfigError"', () => {
    const err = new DeployConfigError('test')
    expect(err.name).toBe('DeployConfigError')
  })
})
