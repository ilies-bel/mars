import type { TaskStatus } from '@/shared/types'

interface Variant {
  label: string
  className: string
  icon: string
}

const VARIANT: Partial<Record<TaskStatus, Variant>> = {
  blocked: {
    label: 'BLOCKED',
    className: 'bg-amber/15 text-ochre',
    icon: '⏸',
  },
  dropped: {
    label: 'DROPPED',
    className: 'bg-iron/10 text-iron line-through',
    icon: '⊘',
  },
  failed: {
    label: 'FAILED',
    className: 'bg-iron/10 text-iron',
    icon: '✕',
  },
}

export const StatusChip = ({ status }: { status: TaskStatus }) => {
  const v = VARIANT[status]
  if (!v) return null
  return (
    <span
      aria-label={v.label.toLowerCase()}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${v.className}`}
    >
      <span aria-hidden="true">{v.icon}</span>
      {v.label}
    </span>
  )
}
