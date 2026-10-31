# Screenshot demo: read-only GitHub issue triage

Demonstrates [PR #1](https://github.com/Azayzel/CompareLab/pull/1): searchable
VS Code tool selection, fresh read-only verification, confirmed live calls,
and evidence-grounded model/prompt comparisons.

Use only public issue data. No shell, repository checkout, writes, or private
telemetry is needed. Live requests consume model quota and require consent.

## Prepare

1. Open CompareLab in a VS Code window with callable models and a configured,
   running GitHub MCP server. If developing from source, use the
   [Extension Development Host instructions](../README.md#quick-start) and
   configure the provider in that window/profile.
2. Confirm the GitHub provider offers text-returning, read-only issue tools.
   Prefer read-only server permissions. Inspect tool descriptions and provider
   behavior before marking anything read-only; the declaration is not a sandbox.
3. Use **Load agent file** to load
   [github-triage.agent.md](github-triage.agent.md).

The agent's `tools: []` intentionally grants no tools if installed in Chat.
CompareLab strips YAML frontmatter and loads only the instruction body.
Its **Select tools** picker independently controls available tools; neither
agent frontmatter nor Chat selections configure this picker. This example lives
under `examples/`, so it is not automatically installed as a workspace agent.

Tool names depend on the MCP provider. A GitHub provider may expose `issue_read`
and `search_issues`, possibly with server prefixes. Select the actual names shown
in your window, not a guessed alias or the entire GitHub tool collection.
For the main demo, only the issue-reading tool is needed. If a tool has a
method selector, verify the whole selected tool is read-only.

## Demo 1: two models, independent live investigations

1. Open **Model comparison** and load the agent as the shared instructions.
   Clear any **Advanced: saved prompt override** on either side.
2. Select two tool-capable models actually available in the picker.
3. Choose **End-to-end agent**. Leave **Source evidence / tool results** empty.
4. Paste this into **Incoming message / trigger**:

```text
Triage https://github.com/microsoft/vscode/issues/345275 for a maintainer.

Read the current issue using the selected GitHub tool. Focus on the reported
difference between typing and pasting a CRON expression. Include the issue's
current state, the reported user impact, any reported workaround, and the most
useful next investigation step. Do not search other issues for this briefing.

Keep the briefing within 220 words and cite the issue.
```

5. Click **Select tools**, search for the issue-reading tool, and select it.
6. Under **Advanced settings**, set **Paired runs** to **1** and keep
   **Check reversed order** enabled. Collapse the settings and click
   **Run comparison**. Choose an available evaluator when prompted.
7. In the fresh verification picker, mark only tools you have independently
   verified are read-only. At each invocation, inspect the requesting model,
   tool, and arguments before approving. Reject unexpected requests.
8. Capture the completed **Analysis overview**, **Model reports**, and
   **Usage and tool details**.

The issue was publicly accessible when this guide was prepared. Its state and
comments can change; the prompt deliberately requests current evidence.
If it becomes inaccessible, use another public, reproducible bug report and
adjust the task. Do not treat inaccessible data as a successful demo.

Both models receive the same verified tool catalog but gather evidence
independently. Differences can reflect investigation choices, not just model
reasoning. One paired run is a walkthrough, not a benchmark. Approval time is
included in latency.

## Demo 2: one model, one instruction change, shared evidence

This shows the other half of the feature: collect evidence once, then test both
prompts against the same snapshot without live tools.

1. Open **Prompt comparison** and select one shared model.
2. Load the example agent into **Original prompt**. Copy its instruction body
   into **Edited prompt**, then append this passage only to the edited version:

```text
Additional triage requirement:
In Evidence, explicitly contrast typing, pasting, and Tab navigation when the
source describes them; mark any unreported input method as unknown.
In Next step, propose a focused regression test with an action and observable
expected result. Label it as proposed, not executed. Preserve the four headings
and the 220-word limit.
```

3. Use this shared input:

```text
Prepare a maintainer briefing for
https://github.com/microsoft/vscode/issues/345275 using its current issue body.
Stay within this issue; do not search related issues or inspect source code.
```

4. Select the same read-only issue tool and leave the shared evidence blank.
   Click **Review prompt change**. Verify tools again and inspect each requested
   call. CompareLab collects one snapshot before running either prompt.
5. Capture the grouped **Original -> Edited** passage, collection progress, and
   the completed recommendation with **See the prompt edit and output evidence**
   expanded.

The added requirement is a hypothesis to test, not a guaranteed improvement.
Capture the actual verdict, including **No clear improvement** or **Worse**.
Do not manufacture a preferred badge or present an incomplete review as a win.
For later reruns, retain the collected snapshot to hold the input data constant;
verify that it still covers the same task. Supplied evidence skips collection,
so use a fresh blank-evidence draft when demonstrating live collection.

## Optional prompt: demonstrate read-only search

For a second live Model comparison scenario, select and independently verify
both issue-reading and issue-search tools. Use the same agent with this trigger:

```text
Within the public microsoft/vscode repository, read issue #345275 and search for
up to three other issues about CRON expression entry in the Automations UI.
Treat this as a focused comparison, not an exhaustive duplicate search.

For each relevant result, cite its URL and explain one concrete similarity or
difference. Distinguish a related symptom from a confirmed duplicate. If no
relevant results are returned, say so and state the search scope.

Use the four briefing headings and stay within 220 words. Do not change issues.
```

Search results may be absent or change. An honest "no relevant results" is a
valid demonstration of uncertainty, not a reason to fabricate matches.

## Screenshot checklist and captions

| Shot | What to show | Suggested caption |
| --- | --- | --- |
| 1 | **Select tools** with a GitHub search filter and the issue tool selected | Choose native VS Code MCP tools for both models. |
| 2 | Fresh read-only verification picker before confirming | Explicitly verify read-only tools for this test; unchecked tools are excluded. |
| 3 | A real invocation confirmation showing model, tool, and public issue arguments | Inspect and approve each individual tool request. |
| 4 | Completed side-by-side **Model reports** with issue citations | Compare independent investigations of the same public issue. |
| 5 | Expanded **Usage and tool details** | Inspect tool arguments and returned evidence behind the answer. |
| 6 | Prompt edit and completed review with supporting quotes | Test an instruction change against one shared evidence snapshot. |

For the docs, shots 1, 3, 4, and 6 tell the shortest complete story. Keep raw
responses collapsed except in the evidence-detail shot. Use a wide editor and
consistent zoom so both reports remain legible.

Capture the real extension, not a mockup. Do not prewrite model responses.
Inspect images for account names, private server names, unrelated tabs, paths,
or other sensitive details before publishing. Crop to the relevant panel or
dialog, while preserving verdicts and caveats.

Use **Export JSON** to retain the run and **Export HTML** for a self-contained
report. Exports include prompts and source evidence; inspect them before
sharing. These examples provide the capture script, not pre-generated
screenshots or a claim that live VS Code/MCP integration has been validated.
