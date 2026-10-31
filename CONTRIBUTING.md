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

The `.vscodeignore` allowlist includes only the manifest, README, license, runtime source, and webview assets. Keep this list in sync when adding runtime files outside `src/` or `media/`. Tests, examples, local exports, editor configuration, and generated packages must not enter the VSIX. See [Build and package](docs/guide.md#build-and-package) for installation and registry-access troubleshooting.

## Code boundaries

| Module | Responsibility |
| --- | --- |
| [src/extension.js](src/extension.js) | VS Code entry point, panel lifecycle, command handling, and run coordination |
| [src/comparison/](src/comparison/) | Comparison engine, rubric/citation validation, prompt workflows, input normalization, and paired orchestration |
| [src/providers/http.js](src/providers/http.js) | Ollama and OpenAI-compatible requests and provider input validation |
| [src/providers/vscode/](src/providers/vscode/) | `models.js`: discovery/selection; `generation.js`: model requests; `review.js`: evaluation and Chat handoff; `limits.js`: shared request limits |
| [src/tools/agent.js](src/tools/agent.js) | Tool catalogs, fresh read-only verification, per-call approval, and investigation loop |
| [src/metrics/](src/metrics/) | Usage accounting, efficiency calculations, and offline price data |
| [src/records/](src/records/) | History persistence, trace imports/validation, and legacy record compatibility |
| [src/reporting/](src/reporting/) | Standalone HTML report rendering |
| [src/webview/panel.js](src/webview/panel.js), [media/](media/) | Editor-panel markup and browser-side behavior/styles |

- Use explicit CommonJS imports from the owning module. Do not add catch-all utilities, barrel exports, or dependency containers just to shorten paths.
- Only the extension entry point imports `vscode`. Pass the API into adapters and the panel renderer so they can be tested outside the editor.
- Keep request execution separate from comparison rules and rendering. Pure helpers should not start model calls or write files.
- Keep module dependencies acyclic. Architecture tests check import resolution and VS Code isolation; behavior tests cover the actual workflows.
- Use Node's built-in test runner with mocked requests. CI must not require credentials or a running model.
- Never pass API keys to the Webview or persist them in experiments.
- Do not treat text differences or literal checks as a verified model-quality score.
- Cover cancellation, invalid citations, missing evidence, response-order changes, and stale assessments when changing the judge. Model verdicts remain advisory, not verified truth.
- For live Copilot smoke tests, use a current VS Code release and approved synthetic inputs. Verify consent/model selection, both orders, cancellation, quota errors, and that Chat opens a new draft without submitting. Mocked command calls do not establish live workbench compatibility.
- Update the relevant README, user guide, DECISIONS, and SKILL sections when behavior or module ownership changes.

## Pull requests

Describe what changed, which tests passed, and whether you performed live provider or VS Code interaction tests. Provide sanitized screenshots for UI changes. Do not include real secrets or proprietary model prompts in issues, fixtures, or logs.
