/**
 * UiDriver Port — headless browser sessions (screenshot capture, navigation)
 * for a repo, abstracted behind a swappable implementation (ADR-0097 "Every
 * seam is a cordis service Port with serializable contracts").
 *
 * ## Serializable contract (hard constraint)
 *
 * Every argument and result is plain, JSON-serializable data — no class
 * instances, no function-typed fields, no live handles (browsers, pages,
 * processes). A browser is the archetypal live handle; this port never
 * exposes one. Methods take a plan and return data. Every live object stays
 * inside the implementation.
 *
 * ## Resolution model
 *
 * Unlike the other ports (verifier, executor, vcs, codeIndex) which are
 * selected by an env var, the UiDriver port uses **probe-based
 * auto-detection**: each registered implementation declares a `probe()`
 * method and the registry returns the first implementation whose probe
 * reports `'available'`. This reflects the fact that the available UI
 * tooling is a machine property, not an operator configuration choice.
 *
 * ## Implementations today
 *
 *  - `playwright-local` — uses a locally installed Playwright + downloaded
 *    browsers. Preferred when available; the most capable option.
 *  - `chrome-exec`       — uses a system Chrome/Chromium binary via its
 *    `--headless --screenshot` CLI flag. No npm package needed beyond a
 *    Chrome install that most developer machines already have.
 *
 * Both are registered in `registry.ts` and resolved in order.
 */

// ---------------------------------------------------------------------------
// Probe result — why an implementation is or is not available
// ---------------------------------------------------------------------------

/** Whether this implementation is usable on the current machine. */
export type UiDriverState = 'available' | 'absent'

/**
 * Result of calling {@link UiDriver.probe} on one implementation.
 * All fields are serializable.
 */
export interface UiDriverProbeResult {
  /** Whether the implementation is usable right now. */
  state: UiDriverState
  /**
   * Human-readable explanation of the probe decision.
   *
   * Mirrors the `evidence` field on `init/detect-verify-gates.ts` gate
   * detection results — same convention, same purpose: a short sentence the
   * operator can read to understand why a candidate was or was not selected
   * (e.g. `"playwright-local: @playwright/test not found in any package.json"`
   * or `"chrome-exec: found at /Applications/Google Chrome.app/..."`).
   */
  evidence: string
  /**
   * Exact shell commands to make this implementation available on the current
   * machine, in order. Empty when `state === 'available'`.
   *
   * When multiple candidates list the same step (e.g. installing a shared
   * tool), the caller deduplicates — never duplicate steps in this array.
   */
  setupSteps: readonly string[]
}

// ---------------------------------------------------------------------------
// Session plan — what to do with the browser (no live objects)
// ---------------------------------------------------------------------------

/**
 * A single screenshot capture: navigate to a URL and write the screenshot to
 * an absolute filesystem path. Both fields are plain strings; no live handles.
 */
export interface UiCaptureSpec {
  /** URL to navigate to before taking the screenshot. */
  navigateTo: string
  /**
   * Absolute filesystem path where the screenshot PNG should be written.
   * The directory must already exist; the implementation does not `mkdirSync`.
   */
  screenshotPath: string
}

/** Result for one {@link UiCaptureSpec}. All fields are serializable. */
export interface UiCaptureResult {
  /**
   * Absolute path of the written screenshot file, or `null` if capture
   * failed (in which case `error` explains why).
   */
  screenshotPath: string | null
  /** Non-null error string when capture failed; null on success. */
  error: string | null
}

/**
 * A browser session plan: an ordered list of captures to execute in sequence.
 * The implementation manages the browser lifecycle internally; the plan
 * carries only serializable data.
 */
export interface UiSessionSpec {
  captures: readonly UiCaptureSpec[]
}

/** Result of one {@link UiSessionSpec} execution. */
export interface UiSessionResult {
  /**
   * One result per entry in the original `captures` array, in the same order.
   * Partial results are never returned: the array length always equals
   * `spec.captures.length`.
   */
  captureResults: readonly UiCaptureResult[]
}

// ---------------------------------------------------------------------------
// UiDriver — the port interface
// ---------------------------------------------------------------------------

/**
 * The UiDriver Port contract. Every method is async and every arg/result is
 * serializable — see the module doc comment above.
 *
 * Implementations must satisfy the hard constraint: no function-typed and no
 * handle-typed fields anywhere in the contract — neither on the method
 * arguments nor on the return types. The browser (or any live process) stays
 * entirely inside the implementation module.
 */
export interface UiDriver {
  /**
   * Stable identifier of this implementation (matches its registry entry).
   * E.g. `'playwright-local'` or `'chrome-exec'`.
   */
  readonly kind: string
  /**
   * One-line description of the capability this implementation provides.
   * Used when building the operator card that lists available options.
   */
  readonly capability: string
  /**
   * Relative install cost, lower = cheaper. Used to sort candidates in the
   * "nothing is available" operator card so the cheapest option is listed
   * first. Examples: `chrome-exec` costs 1 (Chrome is usually pre-installed);
   * `playwright-local` costs 2 (requires npm install + browser download).
   */
  readonly installCost: number
  /**
   * Pure probe: inspect the current machine and `repoRoot` to determine
   * whether this implementation is usable. No child processes, no network.
   *
   * Called by the registry resolver on each registered implementation in
   * order until one reports `state: 'available'`. The resolver never caches
   * the result — a daemon restart or a file change can make a previously
   * absent implementation available.
   */
  probe(repoRoot: string): UiDriverProbeResult
  /**
   * Execute a browser session: navigate and screenshot as described by
   * `spec`. Returns one {@link UiCaptureResult} per entry in
   * `spec.captures`, in order.
   *
   * The implementation is responsible for the full session lifecycle: opening
   * the browser, per-capture navigation + screenshot, and closing/cleaning up.
   * No live object (browser, page, process) crosses this boundary.
   *
   * A failure on one capture must NOT abort the whole session — all captures
   * are attempted and each failure is recorded in its `UiCaptureResult` with
   * `screenshotPath: null` and a non-null `error`. Only infrastructure
   * failures that make further captures impossible (browser crashed, Chrome
   * binary not found) may return early with the remaining results as errors.
   */
  runSession(spec: UiSessionSpec): Promise<UiSessionResult>
}
