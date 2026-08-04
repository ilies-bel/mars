# Provider

A Worker attribute naming which agent CLI a Session drives (claude, codex, gemini, ...); each Provider is one adapter at the provider seam knowing how to spawn that CLI, pass the prompt, and parse its output, session id, and exit. Orthogonal to Runtime: a Provider can run under either Runtime.

_Avoid_: agent backend, vendor, model provider, cli backend
