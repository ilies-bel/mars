export type CompilerFinding = {
  severity: 'warn' | 'error';
  path: string;
  line?: number;
  message: string;
};

export type AgentRole = 'planner' | 'builder' | 'reviewer';

export const AGENT_ROLES: readonly AgentRole[] = ['planner', 'builder', 'reviewer'] as const;

export const ROLE_CONTRACT: Readonly<Record<AgentRole, { inputs: string; outputs: string }>> = {
  planner: { inputs: 'Goal', outputs: 'Plan' },
  builder: { inputs: 'Task', outputs: 'BuildResult' },
  reviewer: { inputs: 'BuildResult', outputs: 'Review' },
};
