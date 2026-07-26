import type { TaskStatus } from '@/shared/types'
import { Badge } from '@/components/ui/badge'

interface Variant {
  label: string
  className: string
  icon: string
}

const VARIANT: Partial<Record<TaskStatus, Variant>> = {
  blocked: {
    label: 'BLOCKED',
    className: 'bg-status-blocked/15 text-status-blocked',
    icon: '⏸',
  },
  dropped: {
    label: 'DROPPED',
    className: 'bg-status-dropped/10 text-status-dropped line-through',
    icon: '⊘',
  },
  failed: {
    label: 'FAILED',
    className: 'bg-status-failed/10 text-status-failed',
    icon: '✕',
  },
}

export const StatusChip = ({ status }: { status: TaskStatus }) => {
  const v = VARIANT[status]
  if (!v) return null
  return (
    <Badge
      aria-label={v.label.toLowerCase()}
      className={`gap-1 rounded border-transparent px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${v.className}`}
    >
      <span aria-hidden="true">{v.icon}</span>
      {v.label}
    </Badge>
  )
}
