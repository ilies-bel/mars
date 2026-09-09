import type { Role } from '@/shared/types'

const COLOR: Record<Role, string> = {
  planner: 'text-warn',
  builder: 'text-highlight',
  reviewer: 'text-muted-foreground',
  orchestrator: 'text-muted-foreground',
}

export const RoleTag = ({ role }: { role: Role }) => (
  <span className={`font-mono text-label font-medium ${COLOR[role]}`}>
    /{role}
  </span>
)
