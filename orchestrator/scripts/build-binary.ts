#!/usr/bin/env tsx
// build-binary.ts  <target>
//
// Compile a standalone single-file mars binary for the given target using
// Bun's compile mode (bun build --compile). The binary embeds the Bun
// runtime; no separate Bun installation is needed to run the output.
//
// Supported targets:
//   darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64 | windows-x64
//
// Usage:
//   tsx scripts/build-binary.ts darwin-arm64
//   npm run build:binary -- linux-x64
//
// Output:
//   mars-<target>[.exe]          — standalone executable
//   mars-<target>[.exe].sha256   — hex digest sidecar (sha256sum format)

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Public API — these pure functions are imported by the test suite.
// ---------------------------------------------------------------------------

export const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'windows-x64',
] as const satisfies readonly string[]

export type Target = (typeof SUPPORTED_TARGETS)[number]

/**
 * Returns true when `target` is one of the five supported os-arch pairs.
 */
export function isValidTarget(target: string): target is Target {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target)
}

/**
 * Returns the output binary file name for the given target.
 * Windows binaries receive the `.exe` suffix; all others do not.
 */
export function getBinaryName(target: Target): string {
  return target.startsWith('windows') ? `mars-${target}.exe` : `mars-${target}`
}

/**
 * Maps our `<os>-<arch>` target string to Bun's `--target` flag value.
 * e.g. `darwin-arm64` → `bun-darwin-arm64`
 */
export function getBunTarget(target: Target): string {
  return `bun-${target}`
}

/**
 * Computes the SHA-256 hex digest of the file at `filePath` by streaming
 * the file through Node's crypto module — no shell-out required.
 */
export function computeHexDigest(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Writes a `.sha256` sidecar file next to `binaryPath`.
 * Content format mirrors `sha256sum(1)`: `<hex>  <filename>\n`
 */
export async function writeSha256Sidecar(binaryPath: string): Promise<void> {
  const hex = await computeHexDigest(binaryPath)
  const sidecarPath = `${binaryPath}.sha256`
  // basename extracted without splitting on the path separator constant so
  // this works on Windows where sep is '\'.
  const fileName = binaryPath.replace(/.*[\\/]/, '')
  await writeFile(sidecarPath, `${hex}  ${fileName}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const target = process.argv[2] ?? ''

  if (!isValidTarget(target)) {
    const list = SUPPORTED_TARGETS.join(', ')
    process.stderr.write(
      `Error: unsupported target '${target}'.\n` +
        `Supported targets: ${list}\n`,
    )
    process.exit(1)
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const packageDir = join(scriptDir, '..')
  const outFile = getBinaryName(target)
  const outPath = join(packageDir, outFile)

  // Inline the current version constant so the compiled binary doesn't need
  // package.json at runtime.
  execFileSync(process.execPath, [join(scriptDir, 'sync-version.mjs')], {
    stdio: 'inherit',
  })

  // Compile to a single-file standalone executable.
  // @duckdb/node-api ships native .node addons that cannot be embedded in the
  // Bun binary; mark them external so Bun emits a clean bundle.
  execFileSync(
    'bun',
    [
      'build',
      '--compile',
      `--target=${getBunTarget(target)}`,
      `--outfile=${outPath}`,
      '--external=@duckdb/node-api',
      '--external=react-devtools-core',
      join(packageDir, 'src', 'cli.ts'),
    ],
    { stdio: 'inherit' },
  )

  // Write the sha256 sidecar next to the binary.
  await writeSha256Sidecar(outPath)

  process.stdout.write(`Built: ${outFile}\n`)
  process.stdout.write(`Sidecar: ${outFile}.sha256\n`)
}

// Run only when invoked directly (not when imported by tests).
const isMain =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g, '/'))

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
