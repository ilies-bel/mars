# skip_reason

The structured signal persisted on a fix-task that ended in done without invoking an agent. Set by the dispatcher when a recovery recipe precondition was already satisfied at dispatch time, recording why no agent run was needed so dirty-tree recovery stays idempotent and observable.
