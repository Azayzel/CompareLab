<img src="media/comparelab-icon.png" alt="CompareLab logo" width="64" height="64">

# CompareLab

Compare two AI models on the same task, or test whether a prompt edit helps.
A VS Code extension with side-by-side responses, text diffs, and reviews
that cite the supplied evidence.

Use models available in VS Code, connect Ollama or an OpenAI-compatible API,
or paste existing responses. No hosted CompareLab service or runtime npm dependencies.

## Quick start

1. Install [CompareLab from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=azayzel-comparelab.comparelab).
2. Click the **CompareLab** Activity Bar icon, then **Open CompareLab**.
3. Choose **Model comparison** or **Prompt comparison** and follow the steps below.

Requires VS Code 1.90+. Live tools require VS Code 1.95+,
a tool-capable model, and a working tool provider in the same window.
MCP support also depends on your VS Code version and server setup.

For source development or a local build, see [build and installation](docs/guide.md#build-and-package).
The **CompareLab: Compare Model Outputs** command remains available in the Command Palette.

## Compare models

1. Enter shared instructions or choose **Load agent file**, then add the incoming task.
2. Select a Baseline and Candidate model.
3. Choose a comparison mode:
   - **End-to-end agent:** select read-only tools; each model investigates independently.
   - **Model / prompt only:** supply evidence; both models answer without live tools.
4. Click **Run comparison**. It runs both sides and reviews their outputs.

Read the reports and cited assessment side by side. The visible run summary shows
how many pairs and reviews are planned; **Advanced settings** also offers simultaneous models and a configurable VS Code timeout (10 minutes by default).
The default is three pairs with reversed-order reviews.

For pasted responses, open each **Paste / edit raw response** editor, then use
**Other actions → Compare text only**. No model call is needed.
Generation-only runs and reviews of existing responses are also under **Other actions**.

## Test a prompt edit

1. Open **Prompt comparison** and select one shared model.
2. Enter the **Original prompt** and **Edited prompt**, plus the shared input.
3. Supply evidence, or select read-only tools to collect it once.
4. Click **Review prompt change**.

By default, both prompts receive the same evidence without live tools.
The review links the instruction change to quotes from both outputs.
It can recommend keeping the original; a different answer is not automatically better.

Try the [Pokemon MCP picnic](examples/pokemon-mcp-demo.md) for a free, no-key tool demo,
or [GitHub triage](examples/github-tools-demo.md). Both include an agent file,
copy-paste prompts, and screenshot tips.
For code, try the [async scheduler challenge](examples/async-scheduler-demo.md) with executable checks.

## Keep and share results

Completed tests save to **History**, including partial runs. Use **Save / export**
for JSON, Markdown, or a self-contained HTML report. Open a saved comparison
without rerunning its models.

## Know the limits

- Reviews are model judgments, not verified correctness or a model leaderboard.
- Required phrase checks block recommendations when they fail; passing is not proof of correctness.
- Live investigations can gather different evidence. Use a shared snapshot to isolate prompt changes.
- Every live test needs fresh read-only verification, and every tool call needs approval.
  Verification is not a sandbox; use trusted tools and read-only server permissions.
  Writes, commands, code execution, and shared-state changes are prohibited.
- Model calls use your configured providers and quota. Manual text comparison stays offline.
- History and exports can contain prompts, responses, and tool results. Inspect them before sharing.

## Development

```sh
npm run build    # Syntax checks, asset validation, and tests; no install needed
npm ci           # Install pinned packaging tools (Node.js 22+)
npm run package  # Build a local VSIX without publishing
```

See [CONTRIBUTING](CONTRIBUTING.md) for the development workflow.

## Releases

After [publishing setup](CONTRIBUTING.md#automated-releases), each merge to `main`
bumps the release patch version and publishes to the [Marketplace](https://marketplace.visualstudio.com/items?itemName=azayzel-comparelab.comparelab)
and [GitHub Releases](https://github.com/Azayzel/CompareLab/releases). Nothing publishes from pull requests.

## Documentation

- [User guide](docs/guide.md): advanced controls, providers, troubleshooting, CLI, and imports
- [Security and data handling](SECURITY.md)
- [Architecture decisions](DECISIONS.md)
- [Comparison procedure](SKILL.md)

[MIT license](LICENSE)
