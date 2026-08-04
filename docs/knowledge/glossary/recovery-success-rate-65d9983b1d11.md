# Recovery success rate

The resilience (self-healing) KPI: the fraction of origin failures whose recovery task reached done AND whose origin then reached done, over the window — i.e. how often self-healing actually heals, per ADR-0002's one-shot recovery. Not capturable today: nothing records recovery outcome distinctly from a normal task transition. Deferred deliberately — it is to be derived from the forthcoming queryable workflow surface rather than bolted onto the current model, so this term names the target without mandating a schema that the workflow rework would obsolete.

_Avoid_: heal rate, fix success rate, recovery rate
