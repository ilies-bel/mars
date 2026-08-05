# Retired --type values were auto|checkpoint; checkpoint maps to gated under --merge

This ADR completes ADR 0016 (Merge-gate axis is named --merge auto|gated, not --type), which renamed the flag but did not record the retired flag's value vocabulary in its body.

The retired flag --type took the values auto|checkpoint. The replacement flag --merge takes the values auto|gated. The mapping is: auto is unchanged (auto -> auto); checkpoint is renamed gated (checkpoint -> gated). Existing queue.db rows with task_type='checkpoint' are rewritten to merge_mode='gated' in place during the column rename, so the retired value 'checkpoint' stops existing in storage just as '--type'/'task_type'/'taskType' do.

This is recorded because ADR 0016's body names only the retired flag and column/field tokens (--type, task_type, taskType) and never the retired value 'checkpoint' or the retired pair 'auto|checkpoint'. Documenting both retired tokens (--type and checkpoint) and the explicit checkpoint->gated mapping closes that gap so the rename's full before/after vocabulary is on record and not re-litigated. Hard cut per the project's no-deprecation policy: no --type alias and no checkpoint value survive anywhere in the tree.
