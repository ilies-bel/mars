/**
 * EnterSessionButton — "Enter session" action for a parked task.
 *
 * Copies `mars enter <taskId>` to the clipboard and surfaces a confirmation
 * toast so the operator can paste the command in a terminal without leaving the UI.
 *
 * The worktree path is rendered as context next to the button so the operator
 * knows which directory the session is running in.
 *
 * `handleEnterSession` is exported as a standalone async function so it can
 * be unit-tested in a node environment without DOM event simulation.
 */

import { toast } from 'sonner'

/**
 * Writes `mars enter <taskId>` to the clipboard and shows a confirmation toast.
 * Exported for direct unit testing.
 */
export async function handleEnterSession(taskId: string): Promise<void> {
  const cmd = `mars enter ${taskId}`
  await navigator.clipboard.writeText(cmd)
  toast.success('Command copied — paste in a terminal to enter the session.', {
    description: cmd,
  })
}

export interface EnterSessionButtonProps {
  /** Mars task id; used to construct the `mars enter <id>` command. */
  taskId: string
  /** Worktree path displayed as context next to the button. */
  worktreePath: string
}

/**
 * Renders an "Enter session" button that copies `mars enter <taskId>` to the
 * clipboard and shows a toast confirming the command is ready to paste.
 */
export const EnterSessionButton = ({ taskId, worktreePath }: EnterSessionButtonProps) => (
  <div data-testid="enter-session-btn" className="flex items-center gap-3">
    <button
      type="button"
      onClick={() => {
        void handleEnterSession(taskId)
      }}
      className="font-mono text-label border border-border px-3 py-1.5 rounded text-muted-foreground hover:bg-foreground/5 transition-colors"
    >
      Enter session
    </button>
    <span className="font-mono text-label text-muted-foreground truncate">
      {worktreePath}
    </span>
  </div>
)
