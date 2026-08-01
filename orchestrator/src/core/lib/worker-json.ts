import { extractLastStreamText } from './claude-stream'
import { PROVIDERS } from '../workers/providers'
import type { ProviderName } from '../workers/provider-types'

const extractJsonObject = (raw: string): string | null => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return raw.slice(start, end + 1)
}

/**
 * Parse a structured worker response through the selected provider's stdout
 * reader. Provider selection, rather than output-shape detection, determines
 * how the stream is decoded.
 */
export const parseWorkerJsonResult = (provider: ProviderName, stdout: string): unknown => {
  const modelText = readWorkerOutputText(provider, stdout)
  if (modelText === null) throw new Error(`${provider} returned no structured output`)

  const objectText = extractJsonObject(modelText) ?? modelText
  try {
    return JSON.parse(objectText)
  } catch (err) {
    throw new Error(
      `failed to parse ${provider} JSON: ${(err as Error).message}\nraw: ${modelText.slice(0, 400)}`,
    )
  }
}

/** Read the final model text through the selected provider's stdout reader. */
export const readWorkerOutputText = (provider: ProviderName, stdout: string): string | null =>
  extractLastStreamText(PROVIDERS[provider].headless.readOutput(stdout))
