/**
 * Kind-tag registry for Mars ids.
 *
 * Every entity kind that carries a MarsId has a 4-letter tag stored here.
 * The rendered form of a full id is `<tag>-<8-hex>`, e.g. `task-04830c8e`
 * or `prop-04830c8e`.
 *
 * `genId(kind)` mints a fresh id for any registered kind.
 *
 * NOTE: `kinds.ts` imports `MarsId` from `./index.ts`, which in turn imports
 * `KIND_TAGS` from this file. This is an intentional ESM circular dependency.
 * It is safe because `genId` only accesses `MarsId` inside the function body
 * (never during module initialisation), so by the time any caller invokes
 * `genId`, both modules are fully evaluated and the live binding is set.
 */
import { randomBytes } from 'node:crypto'
import { MarsId } from './index.js'

export const KIND_TAGS = {
  task: 'task',
  proposal: 'prop',
  'fix-task': 'fixt',
  'inbox-item': 'inbx',
  reflection: 'refl',
  'step-span': 'span',
  'inbox-history': 'inbh',
  origin: 'orig',
  alert: 'alrt',
} as const

export type KindTag = keyof typeof KIND_TAGS

/** Mint a new MarsId for the given kind with a fresh 4-byte random hex. */
export function genId(kind: KindTag): MarsId {
  return MarsId.create(kind, randomBytes(4).toString('hex'))
}
