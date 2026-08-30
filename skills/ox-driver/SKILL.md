---
name: ox-driver
description: >-
  Delegate repository tasks from a host agent or terminal to OpenCode, then
  inspect, repair, compare, and integrate the work through durable route,
  cost, process, change, and acceptance receipts.
license: MIT
metadata:
  version: "2.0.0-dev.0"
---

# Ox Driver

Use Ox Driver when a host agent should supervise one or more OpenCode workers
and retain receipts for the route, reported usage and cost, changed paths,
process cleanup, and acceptance commands.

Work from the extracted Ox Driver directory. Preserve the selected launcher,
provider, model, reasoning effort, agent profile, scope, checks, timeout, and
reported-cost target. A retry uses the recorded route-profile digest and fails
if the profile changed. Create another profile with `--id` and select it with
`--route`; keep profiles referenced by active or retryable runs unchanged.

Preserve the worker's model turns, reasoning, tools, child capacity, context,
output, and wrap-up time. Add or lower a limit only when the user requests it
or a controller policy requires it. Task, pair, and herd lanes default to 3,600
seconds. Collect every independent lane result unless the user requests
fail-fast.

## Set up a route

Install dependencies, build, and create one explicit route profile. The
profile contains route identity and launcher settings; OpenCode continues to
handle authentication.

```bash
npm ci --ignore-scripts
npm run build
node scripts/ox_route.mjs init-opencode \
  --launcher opencode --provider openrouter \
  --model z-ai/glm-5.3-flash --reasoning max
node scripts/ox_route.mjs check
npm exec -- ox-driver-opencode doctor
```

Use provider, model, and reasoning values supported by the installed launcher.
`check` validates the profile file. `doctor` checks the launcher and selected
profile with zero model calls. Authentication and model availability are
tested by the first task dispatch, which may incur provider cost.

## Run one task

```bash
npm exec -- ox-driver-opencode task /absolute/path/to/repository \
  "Implement the requested change, verify it, and report what changed" \
  --owned . --check "npm test"
```

`task` creates a detached managed worktree and leaves it available for review.
The terminal result links the task, worktree, and run receipts. Repeat
`--owned`, `--exclude`, or `--check` for narrower change scopes and multiple
verification commands. Use `--no-check` when the task has no executable check.

The managed worktree starts from `HEAD` unless you pass `--ref`. Uncommitted
and ignored files from the source checkout are absent. Choose an acceptance
command that works in a fresh worktree, or tell the worker to install the
required dependencies.

Allow native OpenCode delegation when the installed profiles support it:

```bash
npm exec -- ox-driver-opencode task /absolute/path/to/repository \
  "Implement the change; delegate independent research where useful" \
  --agent work --child-agent researcher \
  --owned . --check "npm test"
```

Ox Driver records the observed direct-child graph, route, turns, tools, tokens,
and reported cost from OpenCode's structured output and metadata. Repeat
`--child-agent` to allow additional reviewed child profiles.

The one-writer profile policy rejects child profiles that declare direct
write, edit, or patch tools. A shell-capable child may still change files. The
receipt reconciles terminal Git state and does not attribute each path to a
specific agent.

## Run a pair or herd

Create one managed worktree for each writer, then run independent lanes:

```bash
node scripts/ox_workspace.mjs create /absolute/path/to/repository
node scripts/ox_pair.mjs "Implement two independent approaches" \
  --worker /absolute/worktree-a --worker /absolute/worktree-b \
  --role approach-a --role approach-b --check "npm test"
```

`ox_herd.mjs` accepts two to 32 repeated `--worker` paths and an optional
`--concurrency` bound. Use `--lane-spec FILE` when lanes need distinct
objectives, routes, agents, scopes, checks, timeouts, or cost expectations.
Each lane runs in its own worktree. Integration requires an explicit selected
apply operation.

Inspect a finished orchestration and recover its child evidence:

```bash
node scripts/ox_orchestration.mjs inspect ID
node scripts/ox_orchestration.mjs report ID
node scripts/ox_orchestration.mjs archive ID --out /absolute/fresh-directory
node scripts/ox_orchestration.mjs verify-archive /absolute/fresh-directory
```

## Repair one lane

Retry an incomplete lane in its existing managed worktree:

```bash
node scripts/ox_orchestration.mjs retry ID --lane LANE_ID
```

For a herd, retry every incomplete lane while retaining completed siblings:

```bash
node scripts/ox_herd.mjs --retry-failed ID
```

Retry preserves the recorded route, agent, scope, checks, timeout, cost target,
worktree, and prior failed-check context. Inspect the immutable attempt lineage
in the new orchestration receipt.

## Propose and integrate selected work

Start with an evidence-only proposal:

```bash
node scripts/ox_integrate.mjs propose ID
```

The proposal reports each lane's patch source, diff statistics, file overlaps,
conflicting lane IDs, and deterministic apply order. Export a whole patch or a
selected path without changing a repository:

```bash
node scripts/ox_integrate.mjs export ID --lane LANE_ID --out lane.patch
node scripts/ox_integrate.mjs export ID --lane LANE_ID --path src/api
```

Apply explicitly selected, non-conflicting lanes into a new disposable
integration worktree and run controller-owned checks:

```bash
node scripts/ox_integrate.mjs apply ID \
  --lane LANE_A --lane LANE_B \
  --repo /absolute/path/to/repository --check "npm test"
```

The source working tree and refs stay unchanged. Ox Driver returns the
integration worktree ID, applied patch digests, check results, and final status
for host review.

## Inspect, cancel, and clean up

```bash
node packages/opencode-cli/dist/main.js tail RUN_ID --events 40
node packages/opencode-cli/dist/main.js inspect RUN_ID
node packages/opencode-cli/dist/main.js cancel RUN_ID
node packages/opencode-cli/dist/main.js recover RUN_ID
node scripts/ox_orchestration.mjs list
node scripts/ox_workspace.mjs list
node scripts/ox_workspace.mjs remove WORKTREE_ID --discard
```

Inspect diffs before accepting writer changes. Use `recover` after an abrupt
controller exit once the admitted process group has stopped. Use `--discard`
only for a worktree the user intends to abandon; its output lists discarded
paths.

## Operating boundary

OpenCode receives the filesystem and network access of the installed launcher
process. A managed worktree separates Git changes; the launcher retains access
to other host paths and credentials. Run Ox Driver only where the worker may
use the available files, credentials, and network access.

`--owned` and `--exclude` classify Git-visible changes after execution. They do
not prevent reads or writes. A change outside the permitted scope fails receipt
reconciliation.

`--cost-ceiling` evaluates reported cost after execution. It cannot stop
provider billing. Configure a provider-side or launcher-side limit when a run
requires a hard spending cap.

Ox Driver stores objectives, absolute paths, terminal output, events, receipts,
check results, patches, orchestration records, and managed worktrees under the
configured state roots. `OX_DRIVER_STATE_DIR`,
`OX_DRIVER_ORCHESTRATION_STATE_DIR`, and `OX_DRIVER_WORKSPACE_STATE_DIR` select
isolated roots. Other records remain until the operator removes the selected
state directory according to their retention policy.

Credentials belong in the launcher's authentication store. Keep them out of
route profiles, specs, prompts, receipts, repositories, and documentation.

Read [opencode-controller.md](references/opencode-controller.md)
when building RunSpecs directly or diagnosing route, child-lineage,
cancellation, and recovery behavior.
