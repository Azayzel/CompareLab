# CompareLab

**A lightweight VS Code extension for comparing AI model outputs and prompt variants.**

Compare the same prompt on two models, or test a subtle prompt change on one model. CompareLab combines evidence-grounded assessment, readable response views, a Git-style inline diff, and context/usage warnings. **Choose models available in VS Code, paste responses, or optionally run Ollama/OpenAI-compatible endpoints.**

No hosted backend, database, frontend framework, or runtime npm dependencies. Manual comparison remains offline; Copilot evaluation is optional.

## Quick start

Requires **VS Code 1.90+** and **Node.js 20+** for development.

1. Clone this repository and open it in VS Code.
2. Open **Run and Debug**, select **Run CompareLab Extension**, and press **F5** to open a separate **Extension Development Host** window (on macOS, you may need **Fn+F5**).
3. In that **new window**, open the Command Palette (**Cmd+Shift+P** on macOS; **Ctrl+Shift+P** on Windows/Linux) and choose **CompareLab: Compare Model Outputs**. This opens the comparison interface in an editor tab.
4. The default **Model comparison** tab compares two models with shared instructions. Enter **Agent instructions / shared prompt** or choose **Load agent file**. Put the original alert or message in **Incoming message / trigger**. Open **Paste / edit raw response** to compare saved outputs, or select models to generate fresh responses.
5. Click **Select model** for Baseline and Candidate to choose from the models available in VS Code. Then use **Run baseline**, **Run candidate**, **Run both**, or **Orchestrate Test**. Orchestrate Test in **End-to-end agent** mode lets each model independently investigate using approved Datadog MCP tools, without pasted evidence. Existing endpoint providers remain under **Run model (optional)**.
6. Click **Compare text** for readable responses, the inline diff, required-phrase checks, and comparability warnings.
7. Supply **Source evidence / tool results**, then click **Evaluate with Copilot** for a cited assessment, or **Analyze in Copilot Chat** for a new draft you can review and send. Use **Export JSON** to save inputs, **Markdown report** for a text report, or **Export HTML** for a self-contained visual assessment.

**No CompareLab command or panel?** Opening this repository does not install the extension in your regular VS Code window. Use the separate Extension Development Host window from step 2. CompareLab has no dedicated sidebar or bottom-panel view; its editor tab appears only after running the command.

### Model and prompt comparison tabs

- **Model comparison** (default): choose Baseline and Candidate models and supply one shared prompt. Result cards and HTML reports use the model name as their prominent heading, with Baseline/Candidate as a smaller secondary label. Raw response editors are collapsed so long reports do not dominate setup. Saved prompt overrides are retained under **Advanced: saved prompt override**, not silently discarded; clear or update an override before rerunning if the shared prompt changed.
- **Prompt comparison**: a dedicated prompt-edit workflow, not another model dashboard. Select **one shared model**, edit **Original prompt** and **Edited prompt**, and compare grouped **Original → Edited** passages. Related edits on the same or adjacent lines share one card, with local sentence/bullet context and only changed words highlighted—not a separate box for every added or removed word. Unrelated unchanged sections stay hidden; **Show full prompt diff** restores the complete context. Passages sit side by side on wide screens and stack on narrow screens. Identical prompts say **No changes.** **Output changes** and HTML reports use the same presentation; full text remains intact in editors and exports. The main review shows **Better**, **Worse**, or **No clear improvement**, with up to three concrete recommendations linking a changed prompt passage to quotes from both outputs. Full outputs, model metrics, tool traces, and detailed reviews stay under expandable technical details.
- Each comparison tab keeps its own draft, including responses and test records, across tab switches and webview restoration. The initial prompt draft starts from your current baseline/shared instructions without copying old responses. Exports contain only the active comparison, not the other tab's draft. Importing or opening history selects the matching comparison type.
- **History** remains available alongside both workflows. Comparison-type switching is disabled during an active run; you can still browse history and return to the running comparison.

**Save prompt comparisons:** finished prompt tests automatically create History snapshots, including partial/cancelled tests. To save edits before running a test, open **Save / export → Save prompt comparison to History**. Drafts are labeled **Draft · not reviewed**, not mistaken for reviewed results. Snapshots preserve both prompts, shared input/evidence, guided drafts, and any retained outputs/reviews and collection usage. Open one from **History** to restore an editable copy in Prompt comparison without running models or overwriting the saved snapshot. Saving again creates a new entry. History is local to this VS Code profile (latest 50 entries / 100 MiB).

After an ordinary model run, its exact instruction template is pinned as the side's prompt so exported comparisons remain reproducible. Existing JSON experiments without a comparison type continue to open in Model comparison.

Empty or whitespace-only overrides use the **Shared prompt**; meaningful overrides keep their exact text. If a task is genuinely missing, the error names Baseline, Candidate, or both and asks for a Shared prompt or the corresponding override. Empty source evidence does not cause a missing-task error.

### Testing a prompt change

1. Open **Prompt comparison**, select the shared model, and enter or load your original instructions. Edit the second prompt manually, or expand **Help me improve this prompt**: choose a goal, describe constraints to keep, and optionally describe a successful output. **Generate edited draft** explicitly runs a selected rewriting model without Datadog tools. Review/edit its preview and click **Apply draft to edited prompt**. This never changes the original or starts a test.
2. Enter the shared input / alert, then click **Review prompt change**. This single action runs both prompts and reviews their outputs automatically; there is no separate Run, Orchestrate, or Evaluate step in Prompt comparison. New prompt comparisons default to **one paired run**, with a reversed-order review. When evidence is blank, CompareLab collects one read-only Datadog snapshot using the shared model, then sends the exact raw query results to both prompts **without live tools**. Supplied evidence is reused instead. This holds facts constant so different discovered evidence is not mistaken for a prompt improvement.
3. Read the verdict and concise recommendations. Expand their evidence to see the specific prompt edit and output quotes. **Use edited prompt as original** is enabled only for a supported **Better** verdict; it copies the edited instructions to the original and clears old outputs/reviews. **Worse** recommends retaining the original; **No clear improvement** means do not adopt on the strength of this test.
4. Test representative alerts before broad adoption. A supported verdict requires completed comparisons, consistent reversed-order judgments, cited substantive benefits (not just prettier wording), verified grounding, and no conflicting grounding/safety findings or reported prompt regressions. Missing reviews, failures, identical prompts, legacy reviews without change recommendations, or uncertain attribution do not establish improvement.

The shared snapshot is retained in history/exports and reused when you edit a prompt or rerun the comparison. Changing the incoming alert clears an automatically collected snapshot; manually supplied evidence remains under your control. **Test settings and saved outputs (optional)** exposes **Collect fresh evidence and test prompts**, additional paired runs, providers/settings, pasted outputs, and **End-to-end agent** for independent investigations. Saved drafts retain their selected mode; switch older drafts to **Same evidence** to use the new default workflow. Independent mode tests the whole investigation (including query choices), but different evidence prevents clean attribution to the prompt edit.

A progress panel beside **Review prompt change** shows preparation, evidence collection, each prompt output, and output review, with elapsed time, live request/tool activity, and **Cancel review** together. Stages reflect actual work, not an estimated percentage or completion time.

Each prompt-edit recommendation must quote a real instruction change and both outputs. Prompt quotes can include surrounding unchanged words; they are checked against the exact source and must overlap an edit. Invalid citations trigger at most one correction request; unsupported recommendations remain blocked, with the missing requirement identified in the error.

**Review pasted outputs only**, inside the optional settings, reviews supplied responses without generating new ones. Without controlled replay provenance, it may provide useful cited observations but will not establish a prompt improvement. The result explicitly identifies **Not reviewed**, **Review incomplete**, or **Review complete**, and shows completed review counts and any run/review errors. A failed or missing review is not presented as a completed "No clear improvement" judgment. Completed results are brought into view automatically. Text highlighting alone is never a quality judgment. HTML and Markdown exports preserve the prompt-change review and evidence quotes; saved comparisons can be reopened without rerunning anything.

Snapshot collection usage is recorded separately from both prompt generations and evaluator usage. Guided draft usage is retained with the draft, also outside the test totals. Shared-evidence prompt tests using a VS Code model preserve the complete snapshot and count the actual request messages against that model's reported input-token limit, rather than the fixed 150,000-character generation limit. Exact-limit requests are allowed; oversized requests report the required and available tokens and require a larger-context model. Missing/invalid token counts or input limits fail explicitly. Endpoint providers and other generation paths retain the character limit. Timeout, record-size, and cancellation limits still apply; evidence is not silently shortened to fit. A failed collection stops explicitly before either prompt is tested.

### Visual HTML export

**Export HTML** saves an offline `.html` report with embedded styling and the same safe Markdown renderer as the extension. It includes a recommendation overview, green preferred-response cards, token and timing summaries, side-by-side formatted reports, evaluator criteria and expandable source citations, all attempted paired runs and errors, and expandable inputs and the complete comparison record. Historical budget limitations remain visible.

The report uses no CDN, external fonts, or automatic network requests. JavaScript formats Markdown locally; without it, the responses remain readable as raw Markdown. Raw HTML in model output is escaped rather than executed, and Markdown links are restricted to HTTP/HTTPS. A restrictive content security policy is embedded. The layout adapts to narrow screens and includes print styling. Large formatted previews remain capped for responsiveness; **Raw response** and the complete record retain the full text.

Export makes no model or Datadog requests. Like JSON and Markdown exports, HTML includes prompts, responses, and source evidence: review the file for sensitive information before sharing.

The extension can run from source or be installed locally from a VSIX built below; it is not yet published to the VS Code Marketplace.

## Build and package

CompareLab is plain JavaScript, so there is no compilation or bundling step. Run the dependency-free build/validation command from the repository root:

```sh
npm run build
```

This checks all JavaScript syntax, verifies required extension assets, prepares the ignored `dist/` directory, and runs the complete test suite. No `npm install` or registry access is needed. CI uses the same command.

To create a local, installable VS Code extension file for sharing (no publishing required):

```sh
npm run package
```

This uses the standard `@vscode/vsce` packager through `npx`, runs the build and tests through VS Code's prepublish hook, and writes **`dist/comparelab.vsix`**. Despite the hook's name, this command **does not upload or publish anything to npm or the VS Code Marketplace**. npm is used only to download the packaging tool; no npm or Marketplace publishing account is required.

The packager is downloaded on demand and is not version-pinned; it requires approved npm access and a Node version supported by the resolved packager. No runtime dependencies are bundled, and the allowlist excludes tests, examples, local exports, and workspace settings. Repeating the command replaces the generated VSIX.

**Share directly:** send `dist/comparelab.vsix` to the recipient through your approved file-sharing channel. They can install that file using the instructions below without cloning the repository, building the extension, or downloading the packager. Their own model access and, for end-to-end investigations, a configured and authenticated Datadog MCP connection are still required; your credentials and local comparison history are not bundled.

**Install locally:** in VS Code, open the Command Palette, run **Extensions: Install from VSIX...**, select `dist/comparelab.vsix`, and reload if prompted. Then run **CompareLab: Compare Model Outputs** in your normal VS Code window—no Extension Development Host is needed. If the `code` CLI is installed, you can alternatively run:

```sh
code --install-extension dist/comparelab.vsix --force
```

**Packaging download blocked:** if npm returns **403 Forbidden** for `@vscode/vsce`, the packaging-tool download was blocked, not an attempt to publish the extension. Resolve access through your approved npm registry or administrator. `npm run build` still works offline, but it does not create a VSIX; packaging requires an accessible packager.

## Orchestrate Test

**VS Code models is the default provider.** The picker discovers models through VS Code's Language Model API, not a hard-coded list. Availability depends on your installed providers, sign-in, consent and organization policy; it can differ from the Chat picker. No endpoint URL or separate CompareLab API key is needed. Select the model again if it becomes unavailable.

**Picker only showed `copilotcli | auto` with input limit 0, or a Foundry project-selection entry?** These are session/setup entries, not ready-to-call model choices. CompareLab excludes known session-only `copilotcli`/`agent-host-*` providers, the Foundry `__no-project__` placeholder, and entries with unusable advertised input limits. Saved selections are checked again before generation or evaluation. A genuine callable provider's Auto model is not excluded simply because its ID is `auto`.

When no compatible models are exposed, the picker explains what VS Code returned and offers **Retry** or **Open Copilot extension**. Enable/configure a compatible language-model provider in the **same window/profile running CompareLab**; for Copilot, use GitHub Copilot Chat with model API access. An installed but inactive Copilot provider gets one activation attempt before discovery is repeated. Opening the extension page does not install it or change your sign-in automatically. Foundry users must configure a real project/deployment in their provider.

Native Copilot SDK/agent sessions can offer models that are not callable through `vscode.lm`. CompareLab currently uses that direct model API, not the native session transport, so hiding unusable entries cannot grant missing model access. No probe prompts are sent, no guessed model IDs are substituted, and discovery is retried only after provider activation or an explicit Retry.

Known VS Code-only dictation-cleanup models are excluded from both generation and evaluator pickers. If an older saved selection reports **only available to VS Code core**, use **Select model** to choose a regular chat model; CompareLab never silently substitutes a different model. Tool-enabled streams consume text and tool calls while ignoring reasoning and future response parts (unknown types are logged without their content). Reasoning is not displayed or treated as source evidence, and a stream without visible text or tool calls still fails.

**Console mentions an ignored/skipped response part such as `r`?** This is a nonfatal diagnostic for additional provider data, not a failed Datadog call. Bundled class names can be minified; the name alone does not identify the content. CompareLab continues consuming text and tool calls. Check the run status and responses for actual failures.

**Debug Console reports `TypeError: Missing dataLength in event`?** This matches a Node network-inspector bug that can abort HTTP responses when debugging ([nodejs/node#66551](https://github.com/nodejs/node/issues/66551)). The workspace disables the experimental JavaScript Network view in `.vscode/settings.json`; stop and restart the **Run CompareLab Extension** debug session after pulling this change. If launching from another workspace, set `debug.javascript.enableNetworkView` to `false` there too. This disables debugger network inspection, not Datadog access or HTTP requests.

1. Load or paste the agent instructions and supply the incoming trigger. Keep differing per-side prompt overrides empty for a controlled model test.
2. Choose **End-to-end agent** to let each model independently investigate with Datadog MCP. **Source evidence / tool results** is optional in this mode. Enable your Datadog MCP server in VS Code first; CompareLab uses tools exposed through `vscode.lm.tools`, not tools or results inherited from another chat. This requires VS Code 1.95+ and a model that supports tool calling. Alternatively, choose **Model / prompt only** and supply the same frozen evidence both models will receive.
3. Use **Select model** on each side. Optionally choose Ollama or an OpenAI-compatible endpoint instead; match sampling settings and output budgets for those providers where possible.
4. Set **Paired runs** (1 to 5, default 3), leave **Check reversed order** on, and click **Orchestrate Test**. Choose one available Copilot evaluator. In end-to-end mode, CompareLab automatically discovers and enables its recognized read-only Datadog tools; there is no tool picker. Choose **Approve for this test** once to cover both models and all paired runs, or **Review every request** to retain per-call prompts. Approval is not saved or reused by another test. The confirmation lists enabled capabilities and exact tools. Write-capable, code-execution, and unrecognized tools are excluded from automatic setup. The allowlist uses exact documented operation names, not broad `get`/`search` prefixes; names are not proof of provider identity, so only approve tools from your trusted Datadog MCP server. VS Code and the MCP server may still require their own consent.
5. Start with the **Analysis overview** for completed reviews, received responses, and investigation mode. Baseline and Candidate cards summarize success counts, paired timing, and input/output tokens across all completed model turns. Actual provider counts are shown when available; VS Code counts use a clearly labeled `~` estimate instead of "Not reported". A supported task-level preference gets a green **★ Preferred** badge and border/glow on its summary card. Read **Model reports** side by side; the heading identifies the selected run (the latest pair with two responses, or the last attempted pair if none completed). Headings, lists, emphasis, links, tables, and code blocks are formatted for readability. Expand **Raw response** for exact text (formatted previews stop at 100,000 characters; stored responses and exports are unchanged). Raw HTML is displayed as text, and only HTTP/HTTPS Markdown links are clickable.
6. Expand **Run history** entries for individual model reports, per-pair citations, errors, and checks. **Usage and tool details** contains each model's Datadog arguments, timestamps, and full returned text. Each reviewed pair's recommended response also gets a green **★ Preferred** badge and border/glow; this is the evaluator's practical recommendation for that pair, not necessarily a supported overall preference. Ordinary evaluated comparisons use the same highlight. Ties and unevaluated responses are not highlighted. **How to interpret these results** explains comparison limitations and contains the shared input; **Diagnostics** holds the diff, usage tables, and traces. Open run, raw-response, and usage sections in the history stay open as progress updates arrive. Failed or unevaluated runs are labeled explicitly, not presented as model wins.

The evaluator receives both independently gathered evidence sets, labeled by side; neither model receives the other model's investigation. Export JSON or a Markdown **Report** to retain the complete record, including actual and estimated token counts as separate fields.

End-to-end investigations now run in **Full agent** mode. CompareLab no longer caps investigations at eight tool calls, six model requests, or three minutes, reserves no early final-answer turn, and does not truncate tool results or rewrite `max_tokens` arguments. Each model continues using the approved read-only Datadog tools until it answers or you cancel. This can take longer and consume substantially more tokens; use **Cancel** to stop remaining work.

Expand **Investigation instructions** below the shared prompt to see the read-only guidance automatically added to both models' requests. Your agent instructions are not overwritten. Models choose query sizes appropriate to the task and tool schemas. Provider context windows and server-side result limits still apply; full-agent mode does not imply unlimited provider capacity or access to tools outside the Datadog allowlist.

Historical exports remain readable. **Budget-limited** on a saved run means the older runner stopped querying or shortened results because a configured budget was reached; it was not a model-quality verdict. Those original limitations remain visible and such pairs do not count as supported preferences. Rerun the test to obtain a full investigation; omitted historical content cannot be recovered.

Invalid-argument errors (MCP `-32602`) are returned to the requesting model with the tool's advertised schema so it can correct its next call. CompareLab does not silently remove arguments or convert `limit` into `max_tokens` (a token budget, not a row limit). Failed calls are marked `isError` in **Usage and tool details**, retained in history/exports, and excluded from the evaluator's incident evidence. A repeated rejection of the same tool arguments stops the investigation explicitly rather than looping. Corrective model turns and attempted tool calls are included in successful-run usage/activity totals; this does not impose a general investigation budget.

Only text tool results are supported. Missing tools, other tool/provider errors (including authentication and permission failures), refusals, empty results, unsupported result types, and user cancellation still fail explicitly. Each model must query actual Datadog data before its final answer is accepted; loading query guides or receiving argument errors alone does not qualify. Query guides remain in the execution record but are excluded from the evaluator's incident evidence. Previously pasted responses are never reused and no local placeholder answer is substituted. Model usage totals include all completed investigation turns; missing counts remain unknown rather than being presented as complete totals. Latency includes tool calls and approval time.

The analysis cards also show **average input/output tokens per successful run**, **model turns**, and **executed tool calls**. Each side counts only its own investigations, summed across successful runs; candidate totals do not include baseline activity or evaluator usage. Input tokens accumulate across model requests: each follow-up sends that model's conversation, including earlier tool results, again. More tool-calling turns or larger results can therefore increase tokens substantially without twice as many unique observations. The **Quality preference vs. efficiency** section compares candidate input, output, and median time against baseline. Token ratios require all planned runs to succeed and matching usage sources (provider counts on both sides or estimates on both sides); missing counts, zero denominators, and incomplete runs are not presented as meaningful ratios. Timing uses the same pairs with timing on both sides. A preference is not a claim that the preferred model is cheaper or faster.

### Per-turn Azure-equivalent cost estimates

Each newly completed model request retains its input/output token counts, including intermediate tool-calling turns. Cost estimates are not shown as prominent model-card metrics; expand **Per-turn costs and pricing assumptions** to see the total and request-by-request breakdown, in both the panel and HTML report. Investigation totals and evaluator requests (including citation corrections) are separate. JSON/history preserve the per-turn counts; HTML and Markdown reports include the estimates. Older records without per-turn counts remain explicitly unknown; CompareLab does not invent a breakdown from their totals.

- **Basis:** USD, Azure OpenAI Global Standard pay-as-you-go text-token rates. The bundled offline snapshot in [src/azure-prices.js](src/azure-prices.js) was checked on **2026-10-28** against the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) using public East US Global meters. The research covered all pages of that region's Azure OpenAI Consumption meters; 21 exact model IDs have verified text input/output rates in the snapshot. No Azure credentials or network calls are required at runtime.
- **Formula per request:** `(input tokens * input USD per million + output tokens * output USD per million) / 1,000,000`. Actual provider counts take precedence over model-counted estimates. Do not divide a cumulative investigation total by turns to reconstruct request costs.
- **Context pricing:** Some models have separate short- and long-context meters. Where the model-specific cutoff could not be verified, both scenarios are displayed, rather than assuming a tier from the total investigation size. These are conditional pricing scenarios, **not upper/lower bounds on your bill**. [Microsoft's model documentation](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure) says the category depends on input tokens in an individual request, not the model's maximum context window or cumulative investigation total.
- **Verified examples, USD per million input/output tokens:** `gpt-5.6-luna`: **$0.20 / $1.20 short**, **$0.40 / $1.80 long**; `gpt-6.1-sol`: **$2 / $10 short**, **$4 / $15 long**. See [official Azure pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/) for deployment options and current rates.
- **Not billed cost:** Copilot subscriptions, hidden/unreported reasoning, caching discounts and cache-write charges, tools, taxes, negotiated discounts, PTUs, Batch, Flex, Priority and other deployment types are not modeled. All input is priced as uncached. Failed/cancelled requests can consume usage that is not retained. Unknown model IDs, deployment aliases, or missing token counts remain unpriced; there is no fuzzy name matching or silent zero-cost fallback.
- **Historical estimates:** Reports recompute estimates using the bundled dated snapshot, not historical invoices. Update that snapshot only after verifying the exact meters, units (1K versus 1M), deployment type and effective dates. Check current prices before making purchasing decisions.

Other existing safety limits still apply: the shared generation task/evidence request is limited to 150,000 characters, model/evaluator responses to 2 MiB, individual model requests and each paired review to 180 seconds, and the test record to 8 MiB. Direct evaluator reviews retain all supplied evidence and use the selected evaluator's reported input-token limit, not a fixed character cap. Exceeding a limit fails explicitly rather than silently trimming evidence or manufacturing a final answer. Provider rate limits still apply.

### Automatically enabled Datadog capabilities

Local users are expected to have a trusted Datadog MCP server already configured and authenticated in the Extension Development Host's VS Code profile. CompareLab reuses that connection; it does not create servers, copy credentials, or change Datadog permissions. It enables the following recognized tools **when exposed by that connection**, using their current descriptions and argument schemas:

| Capability | Tools |
|---|---|
| Query guides and prerequisites | `list_datadog_skills`, `load_datadog_skill` |
| Logs and SQL analysis | `search_datadog_logs`, `analyze_datadog_logs` |
| Metrics and context | `get_datadog_metric`, `get_datadog_metric_context`, `search_datadog_metrics` |
| APM traces | `get_datadog_trace`, `search_datadog_spans`, `aggregate_spans` |
| Monitors and incidents | `search_datadog_monitors`, `get_datadog_incident`, `search_datadog_incidents` |
| Events and changes | `search_datadog_events`, `aggregate_events`, `get_change_stories` |
| Infrastructure and services | `search_datadog_hosts`, `search_datadog_entities` |
| Dashboard and notebook references | `search_datadog_dashboards`, `get_datadog_dashboard`, `get_datadog_notebook`, `search_datadog_notebooks` |
| RUM | `search_datadog_rum_events`, `aggregate_rum_events` |

The models receive instructions to discover exact guide names, load relevant query guidance, honor tool schemas and required telemetry, scope queries to the event's service/environment/time, and request small result sets. Missing optional product capabilities do not block unrelated investigations; if no recognized data-query tools are exposed, setup fails before generation with an actionable message.

VS Code prefixes MCP tool names with a sanitized server name, sometimes shortened or numbered to avoid collisions. CompareLab matches exact supported operation names after that prefix and invokes the original, unchanged tool ID. For example, `mcp_datadog_mcp_s_search_datadog_logs` is the logs query tool, not a different operation. Generic operations such as `aggregate_spans` are discovered alongside Datadog-named tools from the same generated prefix. If detection fails, the error includes a bounded list of observed tool names; it does not assume that your server is disconnected or its toolsets are disabled.

VS Code models declaring that they cannot call tools are rejected before the paired runs begin. Older models without capability metadata are checked through actual requests, as are Ollama/OpenAI-compatible models; those endpoints must support function/tool calling. Successful setup cannot guarantee a successful investigation: authentication, provider/network availability, retention windows, empty data, and model-generated arguments still affect outcomes. No unapproved write/code-execution tool is automatically enabled to work around a failure.

Live Datadog queries may differ in scope or observation time. End-to-end results therefore compare **agent investigations**, not controlled model-only quality. A supported task-specific investigation preference can be shown when the same majority and evidence checks pass; the independent-evidence notice alone does not block it. The Copilot evaluator reviews the recorded results without making its own live calls.

Runs are sequential, alternating baseline-first and candidate-first to reduce resource contention and ordering effects. In frozen-evidence mode, three pairs make six generation requests and six review requests by default, plus at most three citation corrections. End-to-end mode makes as many generation requests and tool calls as needed, with the same review budget. There is no automatic generation retry. Cancellation stops remaining calls and retains a partial record; failed or incomplete pairs never reuse pasted responses. Test records are bounded to 8 MiB; hitting the limit stops further work and labels the unretained result.

VS Code generation records the selected model/vendor/version, request messages, wall-clock duration, and model-counted input/output token estimates. Input estimates count each request's messages and tool definitions; output estimates count visible text and tool-call output, not hidden reasoning. Repeated conversation context is counted again on each turn. These are **not billed usage**: actual usage remains null, and estimates are retained separately in history and exports. Providers such as Ollama/OpenAI-compatible endpoints retain actual returned usage when available. Output caps, temperature and effective context size are not exposed as controlled settings for VS Code models. The Language Model API receives the instructions as user context (not a privileged system role) and does not inherit Agent-mode tools or chat history. End-to-end orchestration explicitly supplies the approved Datadog MCP tools and executes requested calls. Exact request roles are retained in the test record.

Supported preferences require consistent evaluator order checks, grounded substantive criteria, and no contradictory safety/grounding judgment or severe run warning. Default baseline retention is not counted as a win. A strict majority can produce a **task-specific preference** only when every pair completed and recorded configuration warnings do not confound the result. Other outcomes remain inconclusive. Median latency uses pairs where both generations succeeded; missing usage remains unknown, with known subtotals retained. These are repeated samples of **one task**, not statistical significance, a representative benchmark, verified correctness, or a model leaderboard.

Test JSON includes the instructions, trigger, exact requests, frozen evidence, settings, timestamps, responses, measurements, and assessments. Importing a matching test record or exporting a report makes no model calls. Editing its inputs or responses invalidates the attached record. Imported records are user-controlled artifacts, not authenticated execution attestations.

### CodeMind incoming messages

CompareLab recognizes the web-agent input shapes used by CodeMind's `MappedAlertMessage`, `MappedAlertMapper.ToInput`, `DatadogAlertInput`, and `AgentDefinitionRunner`:

- A mapped envelope containing `alertEvent`, `rawEventRef`, and `sendAlert`. Standardized ID/state/severity/time fields take precedence. Monitor query, scope, service, tags, and related fields come from `additionalDetails`.
- A normalized alert object containing `eventId`, `monitorId`, `title`, `body`, `alertStatus`, and the other `DatadogAlertInput` fields. PascalCase keys are also accepted.

For these inputs, YAML frontmatter is removed from the model-facing agent instructions. With direct Ollama/OpenAI-compatible endpoints, instructions become the **system** message and the normalized event becomes a **user** message beginning `Analyze this Datadog alert event:`. VS Code models receive both as user-context messages through its Language Model API. Orchestrate Test adds either its read-only Datadog investigation policy or its no-live-tools policy and frozen evidence, according to the comparison mode. The raw trigger and original agent text remain in the record. Generated response objects containing `Analysis` are rejected as incoming alerts.

This matches the web event contract and message roles, **not the complete production runtime**: it does not reproduce Kafka delivery filters, registry/thread state, trusted-file hashes, backend-added safety instructions, shared report skills, retrieval, or the mobile investigation-scope builder. Only end-to-end orchestration adds approved Datadog MCP calls; input normalization itself makes no production queries or changes. Include any required runtime/report instructions in the supplied instructions and retain the actual evidence snapshot.

For other messages, `{{alert}}` or `{{message}}` in the instructions is replaced literally; without those placeholders, the message is appended as a separate section. Other placeholders are left untouched. [examples/orchestrated-codemind.json](examples/orchestrated-codemind.json) is an importable synthetic setup; use **Select model** for each placeholder model and replace the synthetic evidence before a real comparison.

## Comparison history

Use the **Compare** and **History** tabs near the top of the panel.

- Finished orchestrated tests save automatically, including partial, failed-generation, and cancelled test records. Cancelling before the test starts does not create a record.
- Use **Save to history** for manual, imported, or individually generated comparisons. Ordinary **Compare text** and evaluation requests do not automatically create snapshots.
- History lists the saved time, task, models, run status, and budget-limited flag. **Open in Compare** restores an editable copy, including the saved review and retained tool evidence, without calling any model or Datadog tool. Opening requires confirmation before replacing your current form. Editing the copy never overwrites the saved snapshot.
- **Delete** and **Clear history** require confirmation. They do not change the current comparison or exported files. **Refresh** picks up entries saved in other windows.
- Retention is **50 entries or 100 MiB of serialized snapshots**, whichever is reached first. Oldest entries are removed automatically. Oversized snapshots are rejected without evicting existing history; export important comparisons separately.
- Storage is shared across workspaces within the same VS Code profile and extension host, using `globalStorageUri/comparison-history`, outside the repository. It survives VS Code restarts. Remote extension hosts use their own storage; different profiles or machines do not share it automatically.

Snapshots are plain JSON, **not encrypted**, and can include sensitive prompts, responses, and Datadog evidence. CompareLab does not sync or upload history and does not copy API keys from SecretStorage. A history write failure is shown explicitly; the completed test remains available to export.

History begins with new saves after this feature is installed. Save the comparison already in your panel, or import an older JSON export and save it, to add existing work.

## Evaluate with Copilot

Provide the original task, both responses, and a frozen evidence snapshot: logs, metrics, tool results, reference material, or expected outcomes. Click **Evaluate with Copilot**, then select an available model. Use a current VS Code release with Copilot access; availability depends on sign-in, organization policy, consent, and quota. No separate provider API key is needed for this workflow.

- The overall result is **Recommend Baseline** or **Recommend Candidate**: a practical recommendation, not proof of superiority. The summary requests confidence, decisive differences, tradeoffs, and evidence that could change the choice. Limited evidence produces a provisional, low-confidence recommendation; ties retain the baseline. Individual criteria can still be **Tie** or **Insufficient evidence**.
- The evaluator receives anonymized A/B response labels, their tasks, and supplied evidence, without provider metadata or tools. Identities mentioned inside response text are not automatically redacted.
- **Check reversed order** is enabled by default and runs **two sequential reviews** with the same selected model. Disagreement produces a provisional recommendation to retain the baseline, not a claim that it is better; both judgments and disputed criteria remain visible. Turning it off runs one review and explicitly records that order was not checked. Invalid citations can trigger **one extra correction request total**, so evaluation uses up to three requests (two without order checking). All requests consume Copilot usage and appear in the run details/report.
- Citations must match supplied text, allowing only whitespace differences and retaining the original source passage. Wording, numbers, punctuation, and Markdown must match. This validates quotation provenance, not whether the passage supports the judgment. Missing evidence prevents verification of factual correctness, but does not block a provisional recommendation based on the tasks and responses; no model assessment is verified ground truth.
- Direct reviews preserve both complete responses, their tasks, and all supplied evidence. Before each request (including reversed order and citation corrections), CompareLab counts the full messages with the selected model's token counter and checks its reported input-token limit. There is no fixed 150,000-character cap on direct review packets. Missing/invalid token metadata fails explicitly rather than assuming the packet fits.
- If the packet exceeds the evaluator's input limit, the error shows the counted tokens, evaluator ID, and reported limit. Choose a larger-context evaluator; CompareLab does not silently excerpt or summarize evidence to make it fit. Larger reviews can take longer and consume more tokens.
- Cancel from the panel or progress notification. Reviews still enforce a 180-second evaluation timeout and a 2 MiB response limit per request.

**Saved review failed with “Review exceeds the 150,000-character limit”?** Older versions applied that fixed cap even after full investigations began retaining larger evidence sets. Updated direct reviews use the evaluator's token limit instead. Open the saved comparison and click **Evaluate with Copilot** to review the displayed response pair without rerunning its investigations; the original historical failed attempts remain unchanged.

If citation correction fails, the error identifies the criterion and source. Try another evaluator or use Chat for manual review; unsupported quotations are never silently accepted. A citation error concerns the evaluator's generated quotation, not necessarily your pasted JSON.

**Analyze in Copilot Chat** opens a fresh Agent-mode draft with the same rubric and source packet. It does not submit, read chat history, or import the resulting answer into the panel. This separate draft handoff retains its 150,000-character safety limit because CompareLab does not select or inspect the eventual Chat model; use direct evaluation for larger packets. Review the draft before sending. Available Chat tools can investigate further, but any newly gathered facts are separate from the frozen in-panel evaluation. The prompt requests read-only investigation; it is not a tool-permission boundary. Chat handoff depends on VS Code workbench commands and still needs live compatibility verification.

## Assessment and export

Quality assessment comes before readable responses. Triage JSON containing `Analysis` or `Recommendation` is rendered without known envelope metadata such as `EventId`, `AgentDefinition`, and `CompletedAt`; raw responses remain available in the diff and exports. Comparability and recorded latency/token usage are separate from quality.

Changing inputs hides the displayed assessment; changed tasks, triggers, evidence, responses, or order settings cannot reuse it. **Report** reuses a matching assessment without another model request and includes source evidence, evaluator identity/version, citations, order verdicts, and run measurements. **Export JSON** saves experiment inputs and review settings. Standalone assessments are not saved in JSON, but orchestrated-test records include their per-pair assessments. Reports without a matching assessment say **Not evaluated**.

## CodeMind execution-trace imports

Export an authenticated CodeMind run attempt from
`GET /agents/runs/{runId}/attempts/{attempt}/export`, then choose **Import JSON** and
select **Baseline** or **Candidate**. Version 1 `codemind-agent-run` exports import
without running any model or fetching evidence; importing the second attempt preserves
the other variant. Ordinary two-variant experiment JSON remains supported.

Expand **Execution traces and context provenance** to inspect ordered model and tool
events, requested versus session-boundary execution attempts, failures/rejections,
deployment versus reported model, context hashes, and any retained snapshots.
Attempt token totals are available only when all recorded model requests have complete
provider usage and event capture is complete; known partial subtotals are labeled.
Cache and reasoning token counts are subsets, never added to input/output totals.
The ordinary variant token fields describe the last returned model request, not the sum.

CodeMind snapshots are opt-in. Metadata-only runs cannot reconstruct their prompts,
tools or evidence; supply the original task explicitly for evaluation. Redacted,
truncated, unfinished, failed and partial captures display warnings. Hashes identify
original content, not a reconstruction, proof of its truth, or evidence of deployed code.
Imports are untrusted provenance, not authenticated attestations. Never put secrets or
unapproved private data in exports. File imports are bounded to 64 MiB (16 MiB per trace), with up to 512
events and 1,000,000 retained snapshot characters per attempt.

Traces survive comparison normalization, panel persistence, JSON export/import, CLI
comparison output, and Markdown reports. Reports include retained snapshots and must be
stored privately. Editing a variant clears attached execution metadata; running a new
model replaces it. Raw context snapshots are not automatically submitted to Copilot:
evaluation still sends only the visible tasks, evidence, and responses.

Choose **End-to-end agent** when tool selection is part of the evaluation. Choose
**Model / prompt only** only with independently frozen or replayed evidence; recorded
context, tool-definition and tool-result differences are confounders. Trace imports do
not implement replay or prove that live external evidence was controlled.

## Run with Ollama

Install and start [Ollama](https://ollama.com/), then use a locally installed model:

```sh
ollama pull qwen3.5:27b
ollama list
```

Choose **Ollama**, enter the installed model ID, and click Run. The default endpoint is `http://127.0.0.1:11434`; CompareLab calls the native `POST /api/chat` route without streaming. No API key is required in this version.

- **Context-window tokens** sends Ollama's `num_ctx`. This is labeled **configured**, not independently verified.
- **Maximum output tokens** sends `num_predict`.
- **Temperature** is only sent when entered.
- Usage is populated from `prompt_eval_count` and `eval_count` when supplied.

Leaving limits empty uses server/model defaults, which CompareLab records as **unknown**, rather than guessing effective context capacity.

## Run with OpenAI / compatible APIs

Choose **OpenAI-compatible API**, enter the model identifier, and optionally override the endpoint (default: `https://api.openai.com/v1`). The integration uses `POST /chat/completions`, **not** the Responses API.

Click **Set API key** to enter a key for that endpoint when needed. Keys are stored in VS Code **SecretStorage**, scoped to the normalized endpoint. They are not stored in Webview experiment state or included in JSON/Markdown exports. The default OpenAI endpoint requires a key; other compatible endpoints may not.

The output-token setting uses `max_completion_tokens` by default. If a compatible server expects the older field, choose `max_tokens`. Some models may reject temperature, token-limit parameters, or Chat Completions entirely; the extension displays an error rather than silently retrying with different settings.

Remote endpoints must use **HTTPS**; HTTP is permitted only for local loopback addresses. Embedded URL credentials, query strings, fragments, and redirects are rejected. **Requests to these endpoints are sent only after clicking Run or Orchestrate Test.** Copilot evaluation uses VS Code's separate Language Model API.

### Run both

Configure providers and model IDs on both sides, then click **Run both**. Runs execute **sequentially**, not concurrently, to reduce resource contention on a shared local GPU. Each successful run updates its response, reported model ID, token usage and finish reason when available. If one side fails, the other is still attempted.

Elapsed duration is recorded in experiment JSON and Markdown reports when available. These sequential wall-clock measurements are not a controlled performance benchmark; missing measurements stay unknown.

## Understanding the results

The inline diff highlights **green additions** to the candidate and **red strikethrough deletions** from the baseline. Text change alone cannot establish that either response is more accurate, safe, or useful.

**Required phrases** are comma-separated, case-insensitive literal substring checks. These checks are deterministic but **not** semantic scoring or fact verification.

CompareLab flags changed prompts, different recorded context-window sizes, output caps, and temperatures; missing provider metadata; and known completion truncation. Its comparison-confidence labels (`comparable`, `unverified`, `caution`, `limited`) summarize **only those checks**. Even `comparable` is **not a fairness guarantee**: system instructions, hidden reasoning, tools, retrieval, snapshot versions, and different tokenizers can confound results.

For team-wide judgments, use a representative task set, fixed acceptance criteria, repeated runs, and human review. See [SKILL.md](SKILL.md).

## CLI and experiment files

The dependency-free CLI compares **supplied** responses and does **not** call model providers:

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

Basic input shape:

```json
{
  "prompt": "Explain HTTP 401 and 403.",
  "baseline": { "model": "model-a", "response": "Authentication failed." },
  "candidate": {
    "model": "model-b",
    "response": "401 means unauthenticated; 403 means access is forbidden."
  },
  "checks": { "requiredPhrases": ["401", "403"] }
}
```

Optional fields include `reportedModel`, `modelVersion`, `contextWindowTokens`, `contextWindowSource`, `inputTokens`, `outputTokens`, `maxOutputTokens`, `finishReason`, and `temperature`. Missing values remain unknown. See [examples/experiment.json](examples/experiment.json) for a sample.

Optional top-level `evidence` contains the source snapshot and `review.checkOrder` controls reversed-order evaluation in the extension. Variant `elapsedMs` records observed duration. The CLI remains offline and does not generate or restore Copilot assessments.

**Exports can contain sensitive prompts, evidence, and responses.** Check them before committing or sharing. API keys are never included.

## Current capabilities

- Optional cited Copilot evaluation and fresh Copilot Chat draft handoff (unreleased additions).
- VS Code model discovery/generation and controlled repeated **Orchestrate Test**, incoming trigger/agent-file inputs, CodeMind web-alert normalization, and exportable per-pair evidence.
- Verdict-first reports, readable triage responses, order-bias checking, and missing-evidence abstention.
- Two-variant word-level inline diff (large inputs use a coarse replacement fallback).
- Per-side manual entry or opt-in non-streaming Ollama/OpenAI-compatible model runs.
- Deterministic required-phrase checks and descriptive comparability warnings.
- JSON import/export, Markdown reports, standalone CLI and Node built-in tests.
- API keys in VS Code SecretStorage; no account, backend, or hosted telemetry.

**Not included:** additional variants, runner streaming/model discovery, OpenAI Responses API, calibrated scoring, proven effective context limits, statistical evaluations, or a quality leaderboard. Unit/host tests and a synthetic desktop/narrow browser fixture cover the new workflow; live providers, Copilot consent/quotas, and Extension Development Host smoke tests remain outstanding.

## Source and documentation

| Path | Purpose |
| --- | --- |
| `src/core.js` | Review rubric and validation, readable responses, text diff, checks, Markdown reports |
| `src/copilot.js` | Copilot model selection, two-order assessment, cancellation, chat draft handoff |
| `src/providers.js` | Native Ollama and OpenAI-compatible HTTP adapters |
| `src/orchestration.js` | Frozen-input plans, bounded paired runs, measurements and test records |
| `src/inputs.js` | CodeMind incoming-alert normalization and model-facing agent instructions |
| `src/extension.js`, `media/` | VS Code Webview, file handling and minimal UI |
| `bin/comparelab.js` | CLI over prepared responses |
| `test/` | Built-in Node tests, mocked provider/Copilot calls and VS Code host behavior |

- [PLAN.md](PLAN.md) — original baseline, delivered milestones, remaining validation.
- [DECISIONS.md](DECISIONS.md) — architecture and tradeoffs.
- [SHELVED.md](SHELVED.md) — explicitly deferred features.
- [SKILL.md](SKILL.md) — repeatable comparison procedure.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and contribution guidelines.
- [SECURITY.md](SECURITY.md) — data, credentials, and connection boundaries.
- [.github/REPOSITORY_METADATA.md](.github/REPOSITORY_METADATA.md) — suggested GitHub About text/topics.

Licensed under [MIT](LICENSE). Current version: **0.2.0**.
