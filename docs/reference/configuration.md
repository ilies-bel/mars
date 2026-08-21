<!-- GENERATED FILE — do not edit by hand.
Run `npm run docs:config` (from orchestrator/) to regenerate from the
`ENV_KNOBS` registry in `orchestrator/src/core/config/env-registry.ts`. -->

# Configuration reference

Every `MARS_*` environment variable Mars reads, the `daemon.json` field it
overrides, its resolved type, its built-in default, and what it controls.
Generated from `ENV_KNOBS` — this table cannot drift from the knobs Mars
actually resolves because it is generated, not hand-maintained. A CI-style
test (`orchestrator/src/core/config/__tests__/reference-drift.test.ts`)
regenerates it and fails if this file disagrees.

| Env var | daemon.json path | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `MARS_MAX_IMPLEMENT` | `caps.implement` | number | `12` | Maximum concurrent Coder (implement) worktrees the dispatcher runs at once. |
| `MARS_MAX_TRIAGE` | `caps.triage` | number | `8` | Maximum concurrent Triage workers. |
| `MARS_MAX_REFINE` | `caps.refine` | number | `6` | Maximum concurrent Refine (Slicer) workers. |
| `MARS_MAX_SETUP_INSTALL` | `caps.setupInstall` | number | `2` | Maximum concurrent worktree dependency installs during setup. |
| `MARS_MAX_VERIFY` | `caps.verify` | number | `1` | Maximum concurrent verify steps. Defaults to 1 because parallel test suites share ports and snapshot dirs and interfere with each other; raise only for explicitly parallel-safe suites. |
| `MARS_SELF_EVOLVE_AUTO_TRIGGER` | `selfEvolve.autoEnqueue` | boolean | `false` | When true, a high-confidence 'mechanical' reflection suggestion is auto-enqueued as a Task instead of left as a draft proposal. |
| `MARS_SELF_EVOLVE_DRIFT_THRESHOLD` | `selfEvolve.driftThresholdPct` | number | `10` | Percent drift threshold that triggers a self-evolve suggestion. |
| `MARS_SELF_EVOLVE_TASK_CONFIDENCE_THRESHOLD` | `selfEvolve.taskConfidenceThreshold` | number | `0.8` | Minimum confidence (0..1) for a 'mechanical' reflection suggestion to be auto-enqueued as a Task when autoEnqueue is true. |
| `MARS_SCORING_AUTO_TRIGGER` | `scoring.autoTrigger` | boolean | `false` | When true, a sustained low score trend raises one draft proposal suggesting a revision of that pipeline. |
| `MARS_SCORING_LOW_TREND_THRESHOLD` | `scoring.lowTrendThreshold` | number | `0.5` | Rolling-median score floor below which the low-trend scoring trigger fires. |
| `MARS_SCORING_LOW_TREND_WINDOW` | `scoring.lowTrendWindow` | number | `5` | Number of consecutive scored workflow instances the rolling-median score trend is computed over. |
| `MARS_WORKER_PROVIDER` | `defaultProvider` | string | `"codex"` | Overrides the default agent provider (claude/gemini/codex) for every un-pinned Worker in this daemon process. |
