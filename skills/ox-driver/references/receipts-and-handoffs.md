# Receipts and handoffs

Ox Driver writes durable run and orchestration records outside the target
repository. A receipt records the requested contract, observed execution, and
controller-owned acceptance results.

## Run receipts

A terminal run receipt contains:

- harness, adapter, tier, and status;
- requested route profile and its digest;
- configured provider, model, and reasoning effort when available;
- start and finish times;
- process exit and cleanup evidence;
- reported provider requests, tools, tokens, children, and cost when available;
- initial, post-adapter, and final Git-visible workspace digests;
- harness, acceptance, aggregate, and out-of-scope changed paths;
- controller-owned acceptance results;
- event-ledger path and digest;
- bounded notices for unsupported or partial evidence.

A completed harness process does not guarantee a completed receipt. Route
drift, malformed evidence, unresolved descendants, out-of-scope changes, and
failed acceptance can fail the run.

## Orchestration receipts

Task, pair, herd, retry, integration, and handoff workflows add an aggregate
receipt. The aggregate links child run identifiers, worktrees, attempts,
effective routes, costs, changed paths, checks, and terminal states.

Inspect a finalized orchestration:

```bash
node scripts/ox_orchestration.mjs inspect ORCHESTRATION_ID
node scripts/ox_orchestration.mjs report ORCHESTRATION_ID
```

Archive bounded receipt evidence for another host or session:

```bash
node scripts/ox_orchestration.mjs archive ORCHESTRATION_ID \
  --out /absolute/path/to/fresh-evidence-directory
node scripts/ox_orchestration.mjs verify-archive \
  /absolute/path/to/fresh-evidence-directory
```

The archive manifest hashes every copied file. A `partial` status names missing
or unverifiable child evidence and preserves every available lane.

## Handoff order

A successful handoff records this sequence:

1. The controller preflights the OpenCode builder and selected reviewer before
   the first model request.
2. The builder completes in one managed worktree.
3. The controller records the builder's exact Git-visible digest.
4. The Pi or OMP reviewer receives that admitted digest.
5. The reviewer completes without a Git-visible change.
6. Controller-owned acceptance commands run against the reviewed state.
7. The controller writes the terminal aggregate receipt.

Reviewer text remains advisory. Inspect the linked reviewer receipt and writer
diff before integration.

## Resume

The handoff command writes a durable checkpoint before paid work and after each
completed stage. Resume with the checkpoint identifier printed by the original
command:

```bash
node packages/cli/dist/main.js handoff resume HANDOFF_CHECKPOINT_ID
```

Resume verifies the route-profile digests, run-state root, worktree identity,
child receipts, and current Git-visible digest. It reuses a completed builder.
A failed or cancelled reviewer receives a linked retry attempt only after an
explicit resume command.

## Retry

Retry one incomplete orchestration lane in its recorded worktree:

```bash
node scripts/ox_orchestration.mjs retry ORCHESTRATION_ID --lane LANE_ID
```

Retry preserves the route, agent, owned and excluded paths, checks, timeout,
reported-cost target, worktree, and attempt lineage. It refuses a changed route
profile or worktree digest when prior evidence binds that value.

## Cancellation and recovery

Request cancellation through the controller:

```bash
node packages/cli/dist/main.js cancel RUN_ID
```

The controller terminates the admitted process group, waits for cleanup, and
records the result. After an abrupt controller exit, inspect the run and verify
that its process group stopped before recovery:

```bash
node packages/cli/dist/main.js inspect RUN_ID
node packages/cli/dist/main.js recover RUN_ID
```

Recovery releases a held workspace lease. It does not rerun work or fabricate
missing evidence.

## Retention

Receipts can contain objectives, absolute paths, terminal output, check output,
patches, and repository metadata. Select state roots and retention periods that
fit the repository's data policy. Keep authentication values out of tasks,
prompts, profiles, and receipts.
