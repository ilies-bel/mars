import type {
  RunRecord,
  RunStatus,
  StepRecord,
  WorkflowStore,
} from './store.js';

/**
 * Reference `WorkflowStore` backed by plain Maps. Durable only for the
 * lifetime of the process — use it for tests and ephemeral runs, or as a
 * worked example of the interface. For on-disk durability use
 * `SqliteStore`.
 *
 * Step records are kept in insertion order per run so `listSteps` reflects
 * the order the workflow function reached them — exactly what the trace
 * view wants for a timeline.
 */
export class InMemoryStore implements WorkflowStore {
  private readonly runs = new Map<string, RunRecord>();
  /** runId -> (stepName -> record), insertion-ordered by Map semantics. */
  private readonly steps = new Map<string, Map<string, StepRecord>>();

  async createRun(run: RunRecord): Promise<void> {
    if (!this.runs.has(run.id)) {
      this.runs.set(run.id, { ...run });
      this.steps.set(run.id, new Map());
    }
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  async setRunStatus(runId: string, status: RunStatus, updatedAt: number): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      this.runs.set(runId, { ...run, status, updatedAt });
    }
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const rec = this.steps.get(runId)?.get(name);
    return rec ? { ...rec } : undefined;
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const byName = this.steps.get(runId);
    if (!byName) return [];
    return [...byName.values()].map((rec) => ({ ...rec }));
  }

  async putStep(record: StepRecord): Promise<void> {
    let byName = this.steps.get(record.runId);
    if (!byName) {
      byName = new Map();
      this.steps.set(record.runId, byName);
    }
    byName.set(record.name, { ...record });
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    this.steps.delete(runId);
  }
}
