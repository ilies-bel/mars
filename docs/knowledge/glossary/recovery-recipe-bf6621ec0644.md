# Recovery recipe

A code-registered handler keyed by failure signature that owns the failure class end-to-end: the plain-language reason shown on its Alert, the operator action set with a recommended action, and the prompt for the spawned recovery task; signatures with no recipe fall back to a first-principles recovery (ADR-0061) and the default action set Diagnose/Continue/Restart.
