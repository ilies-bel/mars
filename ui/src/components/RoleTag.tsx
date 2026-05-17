import type { Role } from '@/shared/types'

const COLOR: Record<Role, string> = {
  planner: 'text-ochre',
  builder: 'text-flame',
  reviewer: 'text-basalt',
  orchestrator: 'text-iron',
}

export const RoleTag = ({ role }: { role: Role }) => (
  <span className={`font-mono text-[11px] font-medium ${COLOR[role]}`}>
    /{role}
  </span>
)
