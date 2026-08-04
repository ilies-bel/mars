# Verb-invocation audit event

A bus event emitted whenever a dispatched Worker Session invokes a mars verb, carrying the resolved Command path, argument shape, and the provenance triple; not emitted for non-Session (human-terminal) callers.

_Avoid_: verb log, command audit, invocation log, verb.invoked
