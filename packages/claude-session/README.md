# @mars/claude-session

Standalone library for programmatically controlling interactive Claude sessions
via a pseudo-terminal (PTY).

## Installation

```sh
npm install @mars/claude-session
```

## Usage

```ts
import { start, getSession, listSessions, VERSION } from '@mars/claude-session';

const session = await start({
  id: 'my-session',
  cwd: process.cwd(),
  args: ['claude', '--no-color'],
  env: {},
  readinessMarker: 'READY',   // optional — wait for this string in output before resolving
});

session.sendMessage('Hello!');
session.onData((chunk) => process.stdout.write(chunk));
await session.exited;
```

## Native dependency — node-pty

This package depends on [node-pty](https://github.com/microsoft/node-pty),
a native Node.js addon that wraps the OS pseudo-terminal API.

**Decision: prebuilt-binary path (option a).**

node-pty v1.1.0 ships prebuilt binaries for the platforms we target:

| Platform      | Covered |
|---------------|---------|
| darwin-arm64  | ✅      |
| darwin-x64    | ✅      |
| win32-arm64   | ✅      |
| win32-x64     | ✅      |

We chose this path because:
- Zero toolchain requirements for the overwhelming majority of consumers.
- The four prebuilt targets cover every platform Mars Framework supports.
- A postinstall hook repairs the `spawn-helper` executable bit on macOS/Linux
  to ensure the prebuilt binary works out of the box after an npm install.

**Fallback for unsupported platforms.** On a platform without a matching
prebuilt (e.g. linux-arm64), npm will attempt to compile node-pty from
source. This requires:
- Python 3
- A C++ build toolchain (`build-essential` / Xcode Command Line Tools)
- `node-gyp` (`npm install -g node-gyp`)

If neither a prebuilt nor a source build succeeds, `@mars/claude-session`
will fail to install. File an issue with your platform details.

## Building from source

```sh
npm run build        # compile src/ → dist/ (ESM + CJS + .d.ts)
npm run build:watch  # watch mode
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```
