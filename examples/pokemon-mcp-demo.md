# Pokemon picnic: a no-key MCP comparison

Give two models the same four Pokemon and ask them to draft a tiny picnic
team. They must call a real MCP tool, add the returned stats, and obey a
budget instead of guessing from familiar characters.

## Free server, no installation

Use the [Pipeworx Pokemon MCP endpoint](https://github.com/pipeworx-io/mcp-pokemon):

```text
https://gateway.pipeworx.io/pokemon/mcp
```

No account, API key, npm package, or local server is needed for this small
demo. The provider currently offers **50 anonymous calls per day**; a live
lookup confirmed that limit on 2026-10-31 UTC. Availability, quotas, and terms
can change. **Model and evaluator usage is separate and may cost money.**

1. In VS Code, run **MCP: Add Server**, choose HTTP, enter the URL above, and
   name the server `pokemon`. Alternatively, merge this entry into your
   workspace's `.vscode/mcp.json`; do not replace existing servers:

   ```json
   {
     "servers": {
       "pokemon": {
         "type": "http",
         "url": "https://gateway.pipeworx.io/pokemon/mcp"
       }
     }
   }
   ```

2. Review the third-party server before trusting it. Start it through
   **MCP: List Servers**. Use a current VS Code release with MCP support.
3. Open CompareLab in that same VS Code window/profile.

If the server says Running but CompareLab cannot see its tools, use
**MCP: List Servers → Show locally configured servers… → pokemon → Start Server**,
then reopen **Select tools**. Some VS Code versions have separate Copilot
agent-host and local MCP runtimes; CompareLab uses the local language-model tools.

The endpoint also advertises unrelated gateway tools, including memory and
routing operations. **Select only `get_pokemon`**, not the whole server.
Its input is `{"name":"pikachu"}` and its output includes `types` and `stats`.
The advertised read-only annotation is not a sandbox or a safety guarantee.
Send only public Pokemon names, never private code, credentials, or logs.

## Two models, one challenge

### Import the ready-made setup

This workspace includes the [Pokemon server configuration](../.vscode/mcp.json).
Use **MCP: List Servers** to start `pokemon` and review any VS Code trust prompt.
Then open CompareLab and use **Import** to load
[pokemon-picnic.json](pokemon-picnic.json).

The preset includes the agent instructions, task, end-to-end mode, one paired
run, and reversed-order reviews. Choose both models with **Select model**,
then select **only `get_pokemon`** in **Select tools** and run the comparison.
Model names are deliberate placeholders: available models and prefixed tool
names depend on your VS Code profile. No permissions or approvals are saved.
The preset embeds the current agent text; after editing the agent, reload it
with **Load agent file** or update the preset before using it again.

### Or configure it manually

1. Choose **Model comparison** and load
   [pokemon-picnic.agent.md](pokemon-picnic.agent.md) with **Load agent file**.
2. Select two tool-capable VS Code models and **End-to-end agent** mode.
   Leave source evidence empty and clear any saved prompt overrides.
3. In **Select tools**, select only the Pokemon server's `get_pokemon` tool.
   VS Code may prefix its name; use the actual picker entry.
4. Set **Advanced settings -> Paired runs** to **1** for a small first test.
5. Paste this into **Incoming message / trigger**:

   ```text
   Draft a two-Pokemon team for a lakeside picnic.

   Candidates: pikachu, eevee, bulbasaur, squirtle.
   Retrieve all four with the selected Pokemon MCP tool.

   Rules:
   - Choose exactly two distinct candidates.
   - At least one must have "water" in its returned types.
   - Their combined base-stat total must be at most 637.
   - Among valid pairs, maximize that combined total.

   Give the pair a playful nickname. Show your arithmetic and explain why
   each other Water-containing pair loses or breaks the budget.
   Use only returned base stats and types, not battle knowledge.
   ```

6. Click **Run comparison**, choose an available evaluator, and freshly verify
   only the selected tool as read-only. Inspect and approve each lookup.
   Expect four successful lookups per model if it follows the prompt; this
   is an instruction, not an enforced call budget.

The agent file's `tools: []` intentionally grants nothing if opened in Chat.
CompareLab strips its frontmatter and loads its instructions; the tool picker
and per-call confirmations are what authorize access.

## What makes a good screenshot?

Capture one approval with the Pokemon name visible, then the side-by-side
roster tables and winning teams. Include **Usage and tool details** to show
that the models actually made MCP calls.

Check tool use, evidence coverage, arithmetic, and constraint-following.
Do not pick a winner just because its nickname or prose is more entertaining.

<details>
<summary>Expected result (spoiler)</summary>

The verified roster totals are Pikachu **320**, Eevee **325**, Bulbasaur
**318**, and Squirtle **314**. Squirtle is the only Water candidate.

- **Pikachu + Squirtle = 634:** valid and highest-scoring.
- Bulbasaur + Squirtle = 632: valid, but lower.
- Eevee + Squirtle = 639: exceeds the 637 cap.

For a harder follow-up, change the cap to **630**. No valid team exists;
a model should explain that rather than quietly relaxing a rule.

</details>

For a prompt-only test, collect the four records once and reuse that frozen
evidence for both prompt variants. Independent live investigations can differ;
one toy run is not a model-quality benchmark.

## Verification and limits

The anonymous MCP handshake, tool discovery, and `get_pokemon` call were
tested on 2026-10-31 UTC. All four roster records were also checked through
the provider's tool API. This does not certify the provider or establish that
a live two-model VS Code comparison was run.

If the server is unavailable or rate-limited, stop the demo or reuse an
explicitly saved evidence snapshot. Do not present remembered stats as live
tool results. See the [provider documentation](https://github.com/pipeworx-io/mcp-pokemon)
and [PokeAPI documentation](https://pokeapi.co/docs/v2) for current details.
