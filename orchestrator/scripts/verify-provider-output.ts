export type ProviderVerificationStatus = 'done' | 'failed' | 'timeout'

/**
 * A completed task only proves the provider verification when the Coder's
 * marker commit is visible on main. `done` without that commit means the
 * standard merge gate was not demonstrated.
 */
export const verificationOutcome = (
  status: ProviderVerificationStatus,
  commitSha: string,
): 'PASS' | 'FAIL' => (status === 'done' && commitSha !== 'none' ? 'PASS' : 'FAIL')
