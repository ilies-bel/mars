import type { Role } from '@/shared/types'

const COLOR: Record<Role, string> = {
  planner: 'text-warn',
  builder: 'text-highlight',
  reviewer: 'text-muted-foreground',
  orchestrator: 'text-primary',
}

export const RoleTag = ({ role }: { role: Role }) => (
  <span className={`font-mono text-meta font-medium ${COLOR[role]}`}>
    /{role}
  </span>
)
