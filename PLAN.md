# PLAN — CompareLab

## Original request (baseline)

Build a visual way to compare outputs from two or more AI models given the same prompt, and to evaluate subtle changes to prompts on the same model. Combine **Git diff** with QuillBot-like readable edit highlighting so a team can see what changed and judge what works best.

Take inspiration from Docker-image Web Vitals skill: capture an explicit baseline and candidate, control variables, record real measurements with provenance, surface confounders and incomplete runs, and publish reproducible results. Don't assume different wording implies a better answer.

## Product constraints

- **VS Code first**, with a reusable core and optional CLI; avoid a separate web application for the initial product.
- Preserve the **simple two-panel UI**; no dashboards, database, authentication service, or third-party runtime packages.
- Make every model request **opt-in**. Keep API keys out of export files and Webview state.
- Treat model context-window claims as **provenance-bearing metadata**, not a guessed constant.
- Never declare a universal winner from a single text diff.

## Shipped: v0.1

- [x] VS Code Webview: baseline, candidate, simple inline word-level diff.
- [x] Separate shared prompt and per-variant overrides.
- [x] Manual pasted responses, JSON import/export, Markdown report.
- [x] Literal required-phrase checks and context/usage comparison warnings.
- [x] Dependency-free `src/core.js` and standalone comparison CLI.
- [x] Initial Node built-in tests and CI.

## Shipped: v0.2

- [x] Opt-in **native Ollama** `/api/chat` runner.
- [x] Opt-in **OpenAI-compatible** `/chat/completions` runner with two output-budget field options.
- [x] Per-side **Run** and sequential **Run both**.
- [x] Exact run prompt, response, returned model identifier, usage counters, and finish reason where supported.
- [x] Optional Ollama `num_ctx`, `num_predict`, and temperature; provider defaults remain unknown when omitted.
- [x] Endpoint-scoped bearer keys via VS Code SecretStorage; no keys in exports.
- [x] HTTPS remote / HTTP loopback only, no redirects, bounded responses, request timeout.
- [x] Mocked tests for successful responses, compatibility fields, missing usage, validation and error paths.
- [x] CI Node tests and syntax checks for extension/Webview files.
- [x] Updated README, security, contribution and reusable comparison procedure.

## Implemented: Copilot assessment (unreleased)

- [x] Explicit Copilot model selection and evidence-grounded six-criterion review.
- [x] Consistent shared-prompt fallback for blank overrides across review, runs, reports, and caching, with webview-to-host regression coverage and side-specific missing-task errors.
- [x] Anonymized A/B packets, exact-source citation validation, missing-evidence abstention.
- [x] Whitespace-tolerant source recovery, criterion/source diagnostics, one bounded citation correction with request accounting and regression tests.
- [x] Same-model reversed-order check by default; disagreements remain visible and can force abstention.
- [x] Fresh Copilot Chat draft handoff without automatic submission or history access.
- [x] Verdict-first UI, readable triage fields, raw diff/details, separate comparability and efficiency.
- [x] Cancellation, bounded input/output, timeout, stale-assessment rejection, cached Markdown export.
- [x] Mock-backed core, Copilot, and host tests; synthetic browser flow and desktop/narrow layout checks.
- [x] Documentation of data boundaries, model-judgment limitations, and follow-up validation.

## Implemented: Orchestrate Test (unreleased)

- [x] VS Code-discovered models as the default for generation and controlled tests, with optional Ollama/OpenAI-compatible endpoints and identical instructions, trigger, and frozen evidence.
- [x] One to five paired repetitions, alternating generation order and selecting the Copilot evaluator once.
- [x] Agent-file loading, separate incoming-message field, CodeMind mapped/normalized web-alert inputs and system/user roles.
- [x] Cancellation, both-provider preflight, partial-failure retention and bounded records.
- [x] Per-pair citations/checks, supported preference counts, latency/token measurements and JSON/Markdown records.
- [x] Synthetic engine/provider/host regressions; live end-to-end model testing remains outstanding.

## Validation status

- [x] GitHub Actions **unit/syntax checks** have passed for v0.2 code.
- [ ] Live Ollama integration smoke test against an installed local model.
- [ ] Live OpenAI/compatible endpoint smoke test (requires user-authorized key/endpoint).
- [ ] Manual interaction/accessibility test in VS Code Extension Development Host.
- [ ] Live Copilot selection/consent, quota failures, streamed review, cancellation, and draft-command compatibility.
- [ ] VSIX packaging and installation smoke test.

Do not represent mock-backed tests as live provider verification.

## Next milestones

1. Finish the live/interactive validation above and fix any compatibility defects.
2. Extend single-task paired samples into representative task suites before offering a team-level decision.
3. Introduce optional provider/model discovery, robust recording of run settings and evidence-based checks.
4. Calibrate the advisory Copilot judge against independent human reviews before team-level scoring; consider additional variants separately.

Future ideas and intentionally deferred scope remain in [SHELVED.md](SHELVED.md). See [DECISIONS.md](DECISIONS.md) for rationale.
