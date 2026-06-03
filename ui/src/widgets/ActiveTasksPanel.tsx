import type { ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Step strip
// ---------------------------------------------------------------------------

const STEPS = ['setup', 'code', 'verify', 'merge'] as const
type Step = (typeof STEPS)[number]

/**
 * Derive the active workflow step from the task.
 * Prefers `currentStep` (added by mars-c07d0768) when present and valid.
 * Falls back to the status enum when the field is absent or unrecognised.
 */
function resolveActiveStep(task: ProgressTask): Step {
  const cs = (task as ProgressTask & { currentStep?: string | null }).currentStep
  if (cs && (STEPS as readonly string[]).includes(cs)) {
    return cs as Step
  }
  switch (task.status) {
    case 'verifying':
      return 'verify'
    case 'merging':
    case 'vega-reconciling':
      return 'merge'
    default:
      // 'running' and any other future active status default to 'code'
      return 'code'
  }
}

interface StepStripProps {
  activeStep: Step
}

const StepStrip = ({ activeStep }: StepStripProps) => {
  const activeIdx = STEPS.indexOf(activeStep)
  return (
    <ol className="flex items-center gap-0.5" aria-label="Workflow steps">
      {STEPS.map((step, idx) => {
        const isDone = idx < activeIdx
        const isActive = idx === activeIdx
        return (
          <li key={step} className="flex items-center gap-0.5">
            {idx > 0 && (
              <span
                className={`h-px w-3 ${isDone || isActive ? 'bg-accent' : 'bg-border'}`}
                aria-hidden="true"
              />
            )}
            <span
              aria-current={isActive ? 'step' : undefined}
              data-done={isDone ? 'true' : undefined}
              className={[
                'rounded px-1 py-0.5 font-mono text-[9px] leading-none',
                isActive
                  ? 'bg-accent text-bg font-semibold'
                  : isDone
                    ? 'bg-accent/20 text-accent line-through'
                    : 'bg-surface text-muted',
              ].join(' ')}
            >
              {step}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

interface TaskRowProps {
  task: ProgressTask
}

const TaskRow = ({ task }: TaskRowProps) => {
  const label = task.prompt.split('\n')[0] ?? task.id
  const activeStep = resolveActiveStep(task)
  return (
    <li className="flex flex-col gap-1 rounded-md border border-iron/10 bg-surface px-2.5 py-2">
      <p
        className="min-w-0 truncate font-mono text-[11px] text-fg"
        title={task.prompt}
      >
        {label}
      </p>
      <StepStrip activeStep={activeStep} />
    </li>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface ActiveTasksPanelProps {
  tasks: ProgressTask[]
}

export const ActiveTasksPanel = ({ tasks }: ActiveTasksPanelProps) => (
  <aside
    className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto border-l border-iron/20 bg-bg px-3 py-3"
    aria-label="Currently worked on"
  >
    <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wide text-muted">
      Currently worked on
    </h2>
    {tasks.length === 0 ? (
      <p className="font-mono text-[11px] text-muted">No active tasks</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ul>
    )}
  </aside>
)
