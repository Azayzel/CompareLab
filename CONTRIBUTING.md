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
npm ci
npm run package
```

Packaging requires **Node.js 22+**. The `@vscode/vsce` version and its dependencies are pinned in the manifest and lockfile; `npm ci` restores them. Its `vscode:prepublish` hook runs the build and tests before packaging, and the output is `dist/comparelab.vsix`. The extension runtime retains Node.js 20+ support. No publishing credentials are needed for local packaging.

The project `.npmrc` uses `https://registry.npmjs.org/` so clean installs work on public GitHub runners. Do not commit organization-private registry settings.

The scoped `minimatch` override addresses [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in the packager's dependency tree. Recheck package contents when updating it; development dependencies are not bundled into the VSIX.

The `.vscodeignore` allowlist includes only the manifest, README, license, runtime source, and webview assets. Keep this list in sync when adding runtime files outside `src/` or `media/`. Tests, examples, local exports, editor configuration, and generated packages must not enter the VSIX. See [Build and package](docs/guide.md#build-and-package) for installation and registry-access troubleshooting.

## Automated releases

[release.yml](.github/workflows/release.yml) runs on pushes to `main`, including merged pull requests. It tests and packages the exact triggering commit, publishes the VSIX to the Marketplace, then publishes a GitHub Release with generated notes and the same VSIX.

### One-time maintainer setup

1. Create or obtain access to the **azayzel** publisher at [Marketplace publisher management](https://marketplace.visualstudio.com/manage). The extension identity is `azayzel.comparelab`.
2. Create a GitHub environment named **marketplace** in this repository. Restrict its deployment branches to **main**. Add reviewers only if you want a manual approval before each release.
3. In the publisher's **Trusted Publishing** settings, create a policy with these exact values:
   - Repository owner: `Azayzel`
   - Repository: `CompareLab`
   - Workflow: `release.yml`
   - Environment: `marketplace`
4. Ensure repository/organization Actions policies permit the workflow's `contents: write` and `id-token: write` permissions. No Marketplace PAT or npm publishing token is used.

See the [official trusted publishing setup](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing). Publishing cannot succeed until the publisher and trust policy are configured; local tests do not verify ownership or live authentication.

### Versions and recovery

- Each new commit gets the next patch above the highest stable `vMAJOR.MINOR.PATCH` tag or the manifest version, whichever is greater. With a `0.2.0` baseline and no tags, the first release is `0.2.1`.
- Versions are written into the build checkout and VSIX, not committed back to `main`. Release tags are the published-version history; changing the manifest's major/minor version establishes a new baseline.
- Reserve and publish versions through this workflow only. Manually publishing the same extension/version outside it breaks the tag-to-artifact provenance used for recovery.
- The workflow serializes releases with `queue: max`, retaining up to 100 pending runs instead of replacing pending merges. GitHub orders the queue by arrival, not guaranteed commit order; an ancestry check refuses to publish older or diverged source over a newer tagged commit.
- After a successful build, a tag reserves the version and a draft release retains the VSIX. If publishing fails, fix the cause and **re-run all jobs on that original workflow run**. It reuses the tag and saved artifact; it does not allocate another patch or replace a published asset.
- If installation fails before a tag is reserved and needs a repository change, merge the fix to `main` to start a new run. Rerunning the old run uses the old files, not the fix; no release version was reserved by that failed installation.
- If Marketplace publication succeeded but GitHub publication failed, a retry accepts that existing Marketplace version and completes the GitHub Release. A completed release is a no-op on rerun.
- Resolve failed releases before merging more changes. If a newer commit has already been tagged, an older unfinished release is intentionally blocked; inspect its draft rather than moving tags or publishing stale code.

## Icons and sidebar

[media/comparelab.svg](media/comparelab.svg) is the artwork source and Activity Bar icon. The sidebar is a launcher for the existing editor, not a second comparison interface. VS Code may tint its Activity Bar icon to match the theme.

Marketplace icons must be PNG, so [media/comparelab-icon.png](media/comparelab-icon.png) is a raster export of the same artwork. Keep it square and at least 128 pixels wide. On macOS, regenerate it with `sips -s format png media/comparelab.svg --out media/comparelab-icon.png`. The build checks both assets; tests check the PNG signature and dimensions.

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
