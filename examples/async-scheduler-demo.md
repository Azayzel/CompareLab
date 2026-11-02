# Hard coding demo: cancellable async scheduler

Compare two models on a small API with difficult concurrency semantics.
Unlike the Pokemon demo, this needs **no MCP server**: both models get the
same precise contract, and you check their code separately.

## Run the comparison

1. Open CompareLab and **Import** [async-scheduler.json](async-scheduler.json).
2. Choose two models. The preset uses **Model / prompt only**, one paired run,
   reversed-order reviews, and no tools.
3. Click **Run comparison** and choose an evaluator.

For slow reasoning models, **Advanced settings** offers a VS Code timeout
(600 seconds by default, up to 3600) and **Run models simultaneously**.
Parallel runs reduce waiting between models but may hit shared provider quotas.

The preset embeds [async-scheduler.agent.md](async-scheduler.agent.md) and the
full contract in **Source evidence / tool results**. Reload the agent if you
edit it; the embedded copy does not update automatically.

Each model must implement `runTasks(tasks, { concurrency, signal })`: bounded
concurrency, input-ordered settled results, eager validation, thenable support,
and cancellation that skips queued work but waits for running tasks.

The traps are deliberate:

- A later invalid task must prevent *all* tasks from starting.
- A task can abort synchronously before the next slot is filled.
- A rejected task must free a slot without failing the whole run.
- Cancellation must not overwrite completed results or abandon active work.
- A thenable can throw while its `then` property is being read.
- Serial execution does not satisfy a concurrency limit of two.

## Check the actual code

Review each response before executing it. Save **only its JavaScript code
block**, without fences, as `baseline.cjs` or `candidate.cjs` outside the
repository. These are executable third-party programs: neither CompareLab
nor the checker sandboxes them. Use a disposable environment without secrets,
private files, or network access for untrusted output.

With Node.js 22+ in that environment:

```sh
node examples/check-async-scheduler.cjs /absolute/path/to/baseline.cjs
node examples/check-async-scheduler.cjs /absolute/path/to/candidate.cjs
```

The checker loads each module and runs 11 cases with Node's built-in test
runner. Failing tests produce a nonzero exit status. Deferred promises control
completion order; the per-test timeout is a hang guard, not a speed benchmark.
It cannot interrupt synchronous infinite loops or malicious code: enforce
process timeouts and isolation externally.

Capture the code side by side, CompareLab's assessment, and each test result.
Use test failures as concrete evidence; the model evaluator cannot execute
these tests and its preference is not proof of correctness.

This is a useful conformance check, not exhaustive certification. Manually
review linear scheduling complexity, abort-listener cleanup, and prohibited
APIs as well. Model/evaluator usage may incur charges; the checker needs no
packages, accounts, or API keys.
