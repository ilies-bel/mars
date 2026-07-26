import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const DeployConfigSchema = z
  .object({
    provider: z.string().min(1),
    env: z.record(z.string(), z.string()).default({}),
    secretsFrom: z.string().optional(),
  })
  .strict()

export type DeployConfig = z.infer<typeof DeployConfigSchema>

export class DeployConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeployConfigError'
  }
}

export async function loadDeployConfig(stateDir: string): Promise<DeployConfig> {
  const configPath = join(stateDir, 'deploy.config.json')

  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (err) {
    throw new DeployConfigError(`deploy config not found at ${configPath}`, { cause: err })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new DeployConfigError(`deploy config at ${configPath} contains invalid JSON`, {
      cause: err,
    })
  }

  const result = DeployConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new DeployConfigError(
      `deploy config at ${configPath} is invalid: ${result.error.message}`,
      { cause: result.error },
    )
  }

  return result.data
}
