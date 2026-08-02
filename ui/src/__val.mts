import * as S from './shared/schemas.ts'

const BASE = 'http://127.0.0.1:7777'
const P = 'p_e8cc6f16a0de'

const checks: Array<[string, any]> = [
  [`/api/tasks?project=${P}`, S.tasksResponseSchema],
  [`/api/progress?project=${P}`, (S as any).progressResponseSchema],
  [`/api/proposals?project=${P}`, (S as any).proposalsResponseSchema],
  [`/api/stale-worktrees?project=${P}`, (S as any).staleWorktreesResponseSchema],
  [`/api/framework-update`, (S as any).frameworkUpdateSchema],
  [`/api/action-queue?project=${P}`, S.actionQueueResponseSchema],
  [`/api/action-queue/history?limit=50`, S.actionQueueHistoryResponseSchema],
  [`/api/kpis?project=${P}`, (S as any).kpisResponseSchema],
]

for (const [path, schema] of checks) {
  if (!schema) { console.log(`SKIP  ${path} (no schema export)`); continue }
  try {
    const r = await fetch(BASE + path)
    const ct = r.headers.get('content-type') ?? ''
    if (!r.ok) { console.log(`HTTP  ${path} -> ${r.status}`); continue }
    if (!ct.includes('json')) { console.log(`CT    ${path} -> ${ct}`); continue }
    const raw = await r.json()
    const res = schema.safeParse(raw)
    if (res.success) console.log(`OK    ${path}`)
    else {
      console.log(`FAIL  ${path}`)
      console.log(JSON.stringify(res.error.issues.slice(0, 8), null, 2))
    }
  } catch (e: any) {
    console.log(`ERR   ${path} -> ${e?.message}`)
  }
}
