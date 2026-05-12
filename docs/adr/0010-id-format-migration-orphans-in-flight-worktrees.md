# Id-format migration orphans in-flight worktrees

When tasks and ideas migrate from prefixed ids (mars-<hex>, <hex>-<slug>) to bare-hex storage, pre-migration worktree directories are not renamed. In-flight tasks at migration time are abandoned and the sweeper cleans up the orphaned worktrees. Chosen over renaming dirs (fiddly with active git refs) and draining the queue first (requires conscious operator stop), because this is a personal dev tool and a one-shot daemon-restart migration is acceptable.
