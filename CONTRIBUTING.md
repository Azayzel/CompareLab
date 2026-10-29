# Contributing

CompareLab should remain small, legible, and local-first. Prefer focused changes to the existing engine and UI over adding a framework, database, or service.

## Develop and test

1. Install **Node.js 20+** and **VS Code 1.90+**.
2. Clone the repository and open it in VS Code.
3. Press **F5** for the Extension Development Host.
4. Validate all JavaScript, required extension assets, and tests:

```sh
npm run build
```

The extension has no third-party runtime packages and needs no transpilation or bundling. `npm run build` checks JavaScript syntax under `src/`, `media/`, `bin/`, `scripts/`, and `test/`, verifies required assets, prepares `dist/`, and runs the test suite. It requires no npm downloads. CI uses this same command; use `npm test` for tests alone.

To produce an installable extension:

```sh
npm run package
```

This invokes the standard `@vscode/vsce` packager through `npx`. Its `vscode:prepublish` hook runs the build and tests before packaging, and the output is `dist/comparelab.vsix`. The packager requires approved npm registry access and a Node version supported by the resolved tool version; its version is not pinned. The extension itself retains its Node.js 20+ requirement. No Marketplace publishing or credentials are needed for local packaging.

The `.vscodeignore` allowlist includes only the manifest, README, license, runtime source, and webview assets. Keep this list in sync when adding runtime files outside `src/` or `media/`. Tests, examples, local exports, editor configuration, and generated packages must not enter the VSIX. See [Build and package](README.md#build-and-package) for installation and registry-access troubleshooting.

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
