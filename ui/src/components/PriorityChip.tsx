type Priority = 'NORMAL' | 'HIGH' | 'BLOCKER'

const STYLE: Record<Priority, string> = {
  NORMAL: 'bg-basalt/10 text-muted',
  HIGH: 'bg-amber/15 text-ochre',
  BLOCKER: 'bg-iron/10 text-iron',
}

export const PriorityChip = ({ priority }: { priority: Priority }) => (
  <span
    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${STYLE[priority]}`}
  >
    {priority}
  </span>
)
