# Command seam

The CLI's testable-unit boundary. Each invocable path (e.g. 'task add', 'glossary set') is one Command registered by its full path in a flat path-keyed registry; the top-level 'task'/'proposal' grouping is computed routing, not a unit. A Command exposes run(args, deps) -> CommandResult{code,value?}; it never calls process.exit (the 110 scattered exits collapse to one site per adapter) and never imports subsystems directly. Two real adapters: production (argv -> route -> run -> process.exit/stdout) and in-process test (constructed args + injected TaskStore(:memory:) + injected daemon-client, asserting on the returned result). Transport (local read vs daemon-routed mutation) is an injected dependency, never a Command taxonomy, because it varies per-subcommand not per-command.

_Avoid_: command handler, subcommand registry, cli router, command pattern
