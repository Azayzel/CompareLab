# CompareLab

Compare two AI models on the same task, or test whether a prompt edit helps.
A VS Code extension with side-by-side responses, text diffs, and reviews
that cite the supplied evidence.

Use models available in VS Code, connect Ollama or an OpenAI-compatible API,
or paste existing responses. No hosted CompareLab service or runtime npm dependencies.

## Quick start

CompareLab is not on the VS Code Marketplace yet. To run it from source:

1. Clone this repository and open it in VS Code.
2. Press **F5** and select **Run CompareLab Extension**.
3. In the new **Extension Development Host** window, run
   **CompareLab: Compare Model Outputs** from the Command Palette.
4. Choose **Model comparison** or **Prompt comparison** and follow the steps below.

Requires Node.js 20+ and VS Code 1.90+. Live tools require VS Code 1.95+,
a tool-capable model, and a working tool provider in the same window.
MCP support also depends on your VS Code version and server setup.

Prefer a local install? See [build and installation](docs/guide.md#build-and-package).

## Compare models

1. Enter shared instructions or choose **Load agent file**, then add the incoming task.
2. Select a Baseline and Candidate model.
3. Choose a comparison mode:
   - **End-to-end agent:** select read-only tools; each model investigates independently.
   - **Model / prompt only:** supply evidence; both models answer without live tools.
4. Click **Run comparison**. It runs both sides and reviews their outputs.

Read the reports and cited assessment side by side. The visible run summary shows
how many pairs and reviews are planned; adjust them under **Advanced settings**.
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

Try the [GitHub demo](examples/github-tools-demo.md) for ready-to-use prompts,
a [triage agent](examples/github-triage.agent.md), and a screenshot walkthrough.

## Keep and share results

Completed tests save to **History**, including partial runs. Use **Save / export**
for JSON, Markdown, or a self-contained HTML report. Open a saved comparison
without rerunning its models.

## Know the limits

- Reviews are model judgments, not verified correctness or a model leaderboard.
- Live investigations can gather different evidence. Use a shared snapshot to isolate prompt changes.
- Every live test needs fresh read-only verification, and every tool call needs approval.
  Verification is not a sandbox; use trusted tools and read-only server permissions.
  Writes, commands, code execution, and shared-state changes are prohibited.
- Model calls use your configured providers and quota. Manual text comparison stays offline.
- History and exports can contain prompts, responses, and tool results. Inspect them before sharing.

## Development

```sh
npm run build    # Syntax checks, asset validation, and tests; no install needed
npm run package  # Build a local VSIX; downloads the packager, does not publish
```

See [CONTRIBUTING](CONTRIBUTING.md) for the development workflow.

## Documentation

- [User guide](docs/guide.md): advanced controls, providers, troubleshooting, CLI, and imports
- [Security and data handling](SECURITY.md)
- [Architecture decisions](DECISIONS.md)
- [Comparison procedure](SKILL.md)

[MIT license](LICENSE)
