# StateStore

The deep module that owns all access to .mars/mars.db (proposals, action queue). Sibling seam to TaskStore: same constructor-injected libsql Client pattern, same generic side door. Collapses the duplicated private getClient()/clientSingleton currently re-declared independently in proposals.ts and lib/action-queue.ts into one connection owner.

_Avoid_: proposals client, state db layer, inbox client
