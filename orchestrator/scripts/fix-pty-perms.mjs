// Fix executable permissions on node-pty's spawn-helper binary.
//
// pnpm's content-addressable store does not preserve POSIX file permissions
// from npm tarballs when hardlinking into node_modules. node-pty's own
// postinstall script only touches build/Release/ (compiled from source),
// leaving prebuilds/darwin-arm64/spawn-helper without its +x bit. Without
// the execute permission, posix_spawnp fails at runtime.
//
// This script runs as a project-level postinstall and fixes the permission
// for whatever node-pty version is present in .pnpm/.

import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const pnpmDir = join('node_modules', '.pnpm')
if (!existsSync(pnpmDir)) process.exit(0)

for (const entry of readdirSync(pnpmDir)) {
  if (!entry.startsWith('node-pty@')) continue
  const helper = join(
    pnpmDir,
    entry,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  )
  if (existsSync(helper)) {
    chmodSync(helper, 0o755)
  }
}
