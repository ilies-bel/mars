# Every seam is a cordis service Port with serializable contracts

# Every seam is a cordis service Port with serializable contracts

## Status
Accepted

## Context
Mars's product pillar is that every module (execution, verification, review,
indexation, planning, recovery, reflect, VCS) can be swapped for another
implementation — including remote ones ("run verification in CI", "review via
an external service"). Today only two real seam patterns exist: the
`createServiceRegistry` registries (providers, workers, verify-heuristics,
primitives) and the `WorkflowStore` interface. Everything else is concrete
coupling. A wire-level (protocol-first) contract for every seam was considered
and rejected: cordis — already re-exported through `@mars/workflow` and
already the sealed-services backbone (ADR-0052) — is purely in-process and
gives us the seam half for free, while protocol-first would require building
RPC machinery cordis does not provide and paying serialization on every local
call.

## Decision
Every swappable module boundary is a **Port**: a cordis service slot bound to
an async TypeScript interface whose method arguments and results are plain
serializable data — no live handles, no callbacks (`onPid`), no process
artifacts (stdout blobs, PTY streams). Local implementations wrap today's
code behind the interface. Remote implementations are ordinary services
filling the same slot; the wire protocol (HTTP/webhook/queue) lives entirely
inside that one adapter, invisible to callers. Callers resolve Ports through
the context (`ctx.get(...)` / sealed accessors), never by importing a concrete
implementation.

## Consequences
- The serializability rule is the acceptance test for every extracted Port;
  today's `HeadlessRunOpts` (`onPid`, pty-shaped `spawnArgv`/`feedPrompt`,
  `readOutput(stdout)`) fails it and must be reshaped.
- Remote execution/verification becomes one adapter file per backend, not a
  cross-cutting change.
- Hard cut per project policy: when a Port lands, the direct-import path and
  provider-named dual types (`RunAgentResult`, `ClaudeEvent`) are deleted in
  the same change.
- Hot, fine-grained in-process extension points (verify heuristics, step
  suggestions) remain plain registries; the Port rule applies to module
  boundaries, not to every function.
