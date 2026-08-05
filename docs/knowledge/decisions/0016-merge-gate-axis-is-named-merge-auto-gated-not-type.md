# Merge-gate axis is named --merge auto|gated, not --type

Task auto-merge vs human-gated-merge is a property of how a task finishes, not a task genre. Naming it --type invited bogus values like --type feature; renaming to --merge auto|gated names what the axis actually controls. The DB column task_type and the structured-spec field taskType are renamed in lockstep (merge_mode / mergeMode) so the wrong-shape concept stops existing rather than being papered over. Hard cut per the project's no-deprecation policy.
