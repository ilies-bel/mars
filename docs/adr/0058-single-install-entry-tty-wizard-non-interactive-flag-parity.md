# Single install entry: one command, TTY wizard or non-interactive, every prompt has a flag

## Status

Proposed (DDD restructure strategy).

## Context

Install today has two routes (prod curl-bootstrap, dev `install.sh`) and `mars
init` detects the stack non-interactively. There is no guided wizard, and the
user wants installation to be *"simple with one command and a wizard, but also
available non-interactively for AI."* The hard requirement that makes this
AI-safe: **nothing may be prompt-only** — every choice the wizard offers must
have a flag or config-file equivalent so a non-interactive caller (CI, an agent)
can supply it.

## Decision

**Single install entry: `mars init`.** Its mode is auto-detected:

- **TTY present** → interactive **wizard** (guided stack detection, workflow
  scaffold choices, project registration).
- **No TTY**, or `--yes`, or `-f <config.json>` → fully **non-interactive** with
  sane defaults / supplied config. AI- and CI-friendly.

**Flag/config parity is an enforced invariant.** Every wizard prompt maps to a
CLI flag or a config-file key; a parity test fails the build if a wizard prompt
has no non-interactive equivalent. `mars init --wizard` can force the guided
path even on a non-TTY for debugging.

As part of `mars init`, the official workflows are scaffolded into
`.mars/workflows/` (ADR-0056).

## Consequences

- One documented command for both humans and agents; the curl-bootstrap and
  `install.sh` routes still place the binary/wrapper, then both converge on
  `mars init`.
- The parity test makes "AI can do everything the wizard can" a build-time
  guarantee, not a hope.
- Wizard questions and their flags live in one declarative table (the source of
  truth for the parity test), so adding a prompt without a flag is impossible
  without failing CI.
- Does not change ADR-0011 (cache dir resolved by env chain, never prompted) —
  that value stays out of the wizard by design.
