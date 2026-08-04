# TaskStore

The deep module that owns all access to .mars/mars.db (task domain). Exposes domain methods (getTask, listTasks, enqueue, claimQueued, updateTask, addBlockers, ...) plus a generic Stmt-based side door (query/execute/atomic) for queries no domain method covers. Hides the libsql Client, Transaction, schema migration, and row<->Task mapping behind one seam. Constructed at the composition root with an injected libsql Client (file: for prod, :memory: for tests); never exposes the raw client. Replaces the exported getClient()/initQueue() pair from queue.ts.

_Avoid_: queue client, getClient, task repository, db layer
