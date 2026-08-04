# Precondition (fix-task)

An optional cheap, no-LLM check that a recovery recipe may declare so the dispatcher can evaluate the condition before spawning the fix-task agent. When the precondition already holds, the dispatcher marks the fix-task done with a skip_reason and never invokes the agent, avoiding no-op recoveries.
