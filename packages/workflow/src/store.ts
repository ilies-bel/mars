/**
 * Persistence seam.
 *
 * `WorkflowStore` is an interface, not a class. Two reference impls ship in
 * the box — an in-memory store (tests, ephemeral runs) and a SQLite store
 * (durable, single file) — but the consumer (Mars) implements it against
 * its own `.mars/queue.db` later. The engine only ever talks to the
 * interface.
 *
 * The per-step record is the heart of the design. It is a single lean row
 * that serves BOTH durability (checkpoint-resume) AND the read-only trace
 * view. Full transcripts are never inlined; they are referenced by key.
 */

/** Terminal-or-in-flight status of a run as a whole. */
export type RunStatus = 'running' | 'completed' | 'failed';

/**
 * Persisted status of a single step.
 *
 * Note there is no persisted `'skipped'`: a step skipped on resume is
 * simply one whose stored status is already `'completed'` from a prior
 * run. Skip is surfaced as a runtime/trace concept (see `StepEvent` and
 * the `skipped` flag on the in-flight handle), never as a stored status.
 */
export type StepStatus = 'running' | 'completed' | 'failed';

/** A persisted workflow run — one row in `workflow_runs`. */
export interface RunRecord {
  /** Stable run identity; keys every step record. */
  id: string;
  /** The workflow's name (its function identity, supplied by the caller). */
  workflowId: string;
  /** The run's input, serialised. */
  inputJson: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * A persisted step record — one row in `workflow_step_runs`, keyed by
 * `(runId, name)`. Lean by design: it carries exactly what resume and the
 * trace view need and nothing more.
 */
export interface StepRecord {
  runId: string;
  /** The explicit, load-bearing step name. Keys resume AND the trace node. */
  name: string;
  status: StepStatus;
  /**
   * The worktree SHA this step ran against, if the caller recorded one.
   * The engine stores it verbatim and never runs git itself; a consumer
   * uses it to re-anchor work on resume.
   */
  sha: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** How many times `fn` has been invoked for this step (1-based once run). */
  attempt: number;
  /**
   * A COMPACT result-or-error summary — a short string, never the full
   * output. On a completed step this summarises the return value; on a
   * failed step `errorSummary` carries the failure and `summary` is null.
   */
  summary: string | null;
  errorSummary: string | null;
  /** Key into external transcript storage; the full output lives there. */
  transcriptKey: string | null;
  /**
   * The step's recorded return value, serialised. This is what resume
   * hands back when it skips `fn`. Kept separate from `summary` so the
   * trace view can stay lean while resume gets the real value.
   */
  resultJson: string | null;
}

/** Fields a step may set when it completes or fails, beyond the result. */
export interface StepOutcomeMeta {
  sha?: string | null;
  transcriptKey?: string | null;
}

/**
 * The persistence contract. All methods are synchronous-friendly but typed
 * async so a remote/db-backed impl can await freely.
 */
export interface WorkflowStore {
  /** Insert a run row in `'running'` status. Idempotent on `id`. */
  createRun(run: RunRecord): Promise<void>;
  /** Look up a run by id, or `undefined` if there is none. */
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** Move a run to a terminal status and bump `updatedAt`. */
  setRunStatus(runId: string, status: RunStatus, updatedAt: number): Promise<void>;

  /** Fetch a single step record, or `undefined` if it has never run. */
  getStep(runId: string, name: string): Promise<StepRecord | undefined>;
  /** All step records for a run, in insertion order (for the trace view). */
  listSteps(runId: string): Promise<StepRecord[]>;
  /**
   * Upsert a step record keyed by `(runId, name)`. The engine writes the
   * full record each time; the store overwrites the existing row.
   */
  putStep(record: StepRecord): Promise<void>;
}
