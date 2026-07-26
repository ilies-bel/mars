/**
 * Built-in Reflector checklist items.
 *
 * Each item carries an optional probe that the checklist runner calls before
 * surfacing the suggestion. If the probe resolves true the item is already
 * satisfied and is silently dropped.
 */
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { ReflectorChecklistItem } from './checklist.js'

const execFile = promisify(execFileCb)

export const builtinChecklist: ReflectorChecklistItem[] = [
  {
    id: 'install-rtk',
    suggest: 'Install RTK for cheaper dev ops',
    probe: async (): Promise<boolean> => {
      try {
        const { stdout } = await execFile('rtk', ['--version'])
        return stdout.startsWith('rtk ')
      } catch {
        return false
      }
    },
  },
]
