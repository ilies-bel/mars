# Workflow

A named, declarative pipeline of typed TypeScript steps composed via the in-house engine's fluent builder (createWorkflow({...}).then(step).then(step).commit()). The Workflow is the runtime contract under which a Task executes: it owns the step shape, the input/output schemas, the order of steps, and the logging surface. In v1 the composition primitive is linear .then chaining only; richer primitives (branching, parallel, foreach, dountil, dowhile) are added when a real pipeline demands them. Workflows are domain-agnostic and introspectable as plain data so future tooling can render them without importing the engine at runtime.

_Avoid_: named pipeline, workflow definition, pipeline, Mastra workflow
