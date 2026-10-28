# Contributing

CompareLab should remain small, legible, and local-first. Prefer focused changes to the existing engine and UI over adding a framework, database, or service.

## Develop and test

1. Install **Node.js 20+** and **VS Code 1.90+**.
2. Clone the repository and open it in VS Code.
3. Press **F5** for the Extension Development Host.
4. Run the test and syntax checks:

```sh
node --test
node --check src/core.js
node --check src/providers.js
node --check src/copilot.js
node --check src/orchestration.js
node --check src/inputs.js
node --check src/extension.js
node --check media/app.js
node --check bin/comparelab.js
```

The extension has no third-party runtime packages or build step. The optional `npm run package` script invokes `@vscode/vsce` through `npx` and may require internet access.

## Code boundaries

- Keep reusable, deterministic comparison logic in `src/core.js`; the CLI and VS Code both use it.
- Keep provider requests and normalization in `src/providers.js`.
- Keep controlled-test plans, sequencing and record validation in `src/orchestration.js`; CodeMind incoming-message conversion belongs in `src/inputs.js`.
- Keep Copilot model calls and Chat handoff in `src/copilot.js`; keep the rubric and citation validation in the shared core.
- Keep the interface in `media/` and the small VS Code host in `src/extension.js`.
- Use Node's built-in test runner with mocked requests. CI must not require credentials or a running model.
- Never pass API keys to the Webview or persist them in experiments.
- Do not treat text differences or literal checks as a verified model-quality score.
- Cover cancellation, invalid citations, missing evidence, response-order changes, and stale assessments when changing the judge. Model verdicts remain advisory, not verified truth.
- For live Copilot smoke tests, use a current VS Code release and approved synthetic inputs. Verify consent/model selection, both orders, cancellation, quota errors, and that Chat opens a new draft without submitting. Mocked command calls do not establish live workbench compatibility.
- Update the README, PLAN, DECISIONS, SKILL, and SHELVED documents when behavior or scope changes.

## Pull requests

Describe what changed, which tests passed, and whether you performed live provider or VS Code interaction tests. Provide sanitized screenshots for UI changes. Do not include real secrets or proprietary model prompts in issues, fixtures, or logs.
