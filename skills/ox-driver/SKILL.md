---
name: ox-driver
description: >-
  Delegate repository writing and review from a host agent or terminal to
  OpenCode, Pi, or OMP. Preserve selected routes and return durable receipts
  for output, usage, reported cost, process cleanup, changed paths, and
  acceptance checks.
license: MIT
metadata:
  version: "2.0.0-dev.0"
---

# Ox Driver

Dispatch bounded repository work to OpenCode, Pi, or OMP and return the result
with a durable controller receipt.

Work from the Ox Driver source directory. Preserve the user's selected harness,
launcher, provider, model, reasoning effort, agent profile, repository scope,
checks, timeout, and reported-cost target. A retry reuses the recorded route
profile and fails preflight with `ROUTE_PROFILE_DRIFT` when the prior receipt
recorded a route-profile digest and the current profile no longer matches it.

Preserve the selected worker's available model turns, reasoning, tools, child
capacity, context, output, and wrap-up time. Add or lower a limit only when the
user requests it or a controller policy requires it. Keep independent lanes in
collect-all mode unless the user requests fail-fast.

State an unavailable capability. Never replace the selected harness, route,
topology, or review stage with a weaker option without the user's approval.

## Choose a workflow

| Goal | Harness and workflow |
| --- | --- |
| Implement one repository change | OpenCode managed task or Pi solo writer |
| Use receipt-aware direct research children | OpenCode task with direct children |
| Run a team, staged workflow, or comparison | Any combination of OpenCode, Pi, and OMP lanes |
| Review an admitted snapshot without changes | Pi solo read-only review or OMP attested review |
| Review completed OpenCode changes | Handoff with Pi or OMP as reviewer |
| Inspect an installed ACP or DeepSeek Harness adapter | Zero-model `doctor`; task dispatch stays blocked |

OpenCode supports writing, direct children, pairs, teams, dependencies, retry,
and checked integration. Pi supports writing, read-only review, teams,
dependencies, retry, and checked integration from team writer lanes. OMP
supports read-only review as a solo run or team lane on a qualified macOS
arm64 route. A team may use one harness throughout or mix all three
dispatchable harnesses.

Ox-managed Pi child-profile selection is unavailable. OMP writing and OMP
child agents are unavailable. ACP and DeepSeek Harness task dispatch is
unavailable.

## Check routes before dispatch

List every adapter without making a model request:

```bash
node packages/cli/dist/main.js doctor --all
```

Require the selected harness to report `available: true`, a configured route,
and an execution-qualified probe. Stop before dispatch when doctor reports a
blocked or degraded route that cannot satisfy the task.

Create route profiles with `scripts/ox_route.mjs` when needed:

```bash
node scripts/ox_route.mjs init-opencode \
  --launcher opencode --provider PROVIDER --model MODEL --reasoning EFFORT

node scripts/ox_route.mjs init-pi \
  --launcher pi --provider PROVIDER --model MODEL --reasoning EFFORT

node scripts/ox_route.mjs init-omp \
  --launcher omp --provider PROVIDER --model MODEL --reasoning EFFORT \
  --agent-dir /absolute/path/to/omp-agent \
  --home-dir /absolute/path/to/omp-home
```

Use values supported by the installed harness. Route profiles contain route
identity and launcher configuration. Harness authentication remains outside
the profile.

## Run one OpenCode task

```bash
npm exec -- ox-driver-opencode task /absolute/path/to/repository \
  "Implement one focused change and report the result" \
  --route opencode-default \
  --owned . \
  --check "npm test"
```

The task command creates a detached managed worktree and preserves it for
inspection. Repeat `--owned`, `--exclude`, and `--check` to define the work.
Use `--no-check` only when no executable acceptance command applies. `--check`
and `--no-check` cannot be combined.

Allow direct children only when the selected primary and child profiles passed
route and tool-policy checks:

```bash
npm exec -- ox-driver-opencode task /absolute/path/to/repository \
  "Implement one focused change; delegate independent research when useful" \
  --route opencode-default \
  --agent primary-agent \
  --child-agent research-agent \
  --owned . \
  --check "npm test"
```

Each allowed child inherits the primary provider, model, and reasoning effort.
The receipt records observed direct child lineage, route, usage, tools, and
reported cost. Child changes remain aggregate to the parent worktree.

## Run Pi

Run a solo writer:

```bash
node scripts/ox_pi.mjs /absolute/path/to/repository \
  "Implement one focused change and report the result" \
  --route pi-default \
  --writer \
  --owned . \
  --check "npm test"
```

Run a solo read-only review:

```bash
node scripts/ox_pi.mjs /absolute/path/to/repository \
  "Review this repository for correctness risks" \
  --route pi-default
```

The Pi writer requires at least one `--owned` path and uses the installed
launcher's normal tool surface. The reviewer uses the controller's read-only
tool policy. `ox_pi.mjs` rejects OpenCode-style `--agent` selection. Use Pi as
the only harness in a team or combine Pi lanes with OpenCode and OMP lanes.

Ox Driver creates no managed worktree for a Pi writer. It passes the repository
argument through as the run's working directory, so the writer edits that
directory in place. Create a disposable worktree with
`node scripts/ox_workspace.mjs create /absolute/path/to/repository` first and
pass the `path` it prints.

## Run an OMP review

```bash
node packages/cli/dist/main.js omp-review \
  /absolute/path/to/repository \
  "Review this repository for correctness risks" \
  --route omp-default \
  --no-check
```

OMP review is ephemeral, read-only, and limited to a qualified macOS arm64
route. Add one or more `--check` arguments when executable acceptance applies.
Use an OMP team lane when review must follow a dependency. `--check` and
`--no-check` cannot be combined.

## Run a checked handoff

```bash
node packages/cli/dist/main.js handoff \
  /absolute/path/to/repository \
  "Implement one focused change" \
  --owned . \
  --builder-route opencode-default \
  --reviewer pi \
  --reviewer-route pi-default \
  --check "npm test"
```

Select `--reviewer omp --reviewer-route omp-default` for OMP. The controller
preflights both routes before the writer runs. It binds the reviewer to the
writer's Git-visible digest and runs controller-owned checks after review.

Resume a completed-writer checkpoint without paying for that stage again:

```bash
node packages/cli/dist/main.js handoff resume HANDOFF_CHECKPOINT_ID
```

## Run a team of lanes

A team run has three steps: create worktrees for its branches, dispatch the
plan, then inspect the aggregate receipt and integrate selected work.

### Create one worktree per lane

```bash
node scripts/ox_workspace.mjs create /absolute/path/to/repository
```

Each call prints JSON holding the new worktree's `id` and `path`. Give
independent lanes separate paths. Ordered lanes may reuse a path when
`dependsOn` makes their order explicit; Ox binds the later lane to the earlier
lane's terminal workspace digest.

### Dispatch every lane on one objective

```bash
node scripts/ox_herd.mjs "Implement two independent approaches" \
  --worker /absolute/path/to/worktree-a \
  --worker /absolute/path/to/worktree-b \
  --check "npm test"
```

Repeat `--worker` for two to 32 lanes. `ox_pair.mjs` takes the same arguments
for exactly two OpenCode writers. Both commands require at least one `--check`
or explicit `--no-check`.

### Dispatch a lane plan

Write a version-1 plan when lanes need different objectives, harnesses, routes,
dependencies, agents, scopes, checks, timeouts, or cost targets:

```json
{
  "version": 1,
  "lanes": [
    {
      "id": "cache",
      "role": "cache-approach",
      "harness": "opencode",
      "objective": "Add a response cache and keep the public API unchanged",
      "workerPath": "/absolute/path/to/worktree-a",
      "route": "opencode-default",
      "ownedPaths": ["src", "tests"],
      "checks": ["npm test"],
      "timeoutSeconds": 1800,
      "costCeilingUsd": 0.05
    },
    {
      "id": "index",
      "role": "index-approach",
      "harness": "opencode",
      "objective": "Add a lookup index and keep the public API unchanged",
      "workerPath": "/absolute/path/to/worktree-b",
      "route": "opencode-default",
      "ownedPaths": ["src", "tests"],
      "checks": ["npm test"],
      "timeoutSeconds": 1800,
      "costCeilingUsd": 0.05
    },
    {
      "id": "minimal",
      "role": "minimal-approach",
      "harness": "pi",
      "writerPolicy": "one-writer",
      "objective": "Implement the smallest correct fix and keep the public API unchanged",
      "workerPath": "/absolute/path/to/worktree-c",
      "route": "pi-default",
      "ownedPaths": ["src"],
      "excludedPaths": ["docs"],
      "checks": ["npm test"],
      "costCeilingUsd": 0.05
    },
    {
      "id": "review",
      "role": "reviewer",
      "harness": "omp",
      "writerPolicy": "read-only",
      "dependsOn": ["minimal"],
      "objective": "Review the exact terminal state of the minimal approach",
      "workerPath": "/absolute/path/to/worktree-c",
      "route": "omp-default",
      "checks": ["npm test"],
      "costCeilingUsd": 0.02
    }
  ]
}
```

```bash
node scripts/ox_team.mjs run /absolute/path/to/lanes.json --concurrency 4
```

A lane plan gives every worker a named role. An OpenCode lane may declare
`agent` and `childAgents` for native direct children. A Pi lane may declare
`"writerPolicy": "one-writer"` with at least one `ownedPaths` entry. An OMP
lane stays read-only. A dependent lane receives bounded evidence and output
from each completed dependency.

`ox_team.mjs run` writes `OX_DRIVER_ORCHESTRATION_ID=ID` to stderr at allocation and
the aggregate receipt to stdout at the end. Use that identifier for every step
below.

### Lane rules

- `id`, `role`, `objective`, and `workerPath` are required. `workerPath` must be
  absolute.
- `harness` is required by `ox_team.mjs run`. `writerPolicy`, `dependsOn`,
  `route`, `agent`, `childAgents`, `ownedPaths`, `excludedPaths`, `checks`,
  `timeoutSeconds`, and `costCeilingUsd` are optional. Plan validation rejects an unknown key;
  `schemas/orchestration-plan.schema.json` is the authority on the accepted set.
- `id` and `role` must be distinct across lanes. Independent lanes use
  distinct worktrees. Dependency-ordered lanes may reuse one worktree.
- `harness` accepts `opencode`, `pi`, or `omp`. Ox resolves runners only for
  the harnesses named by the plan.
- `writerPolicy` accepts `read-only` or `one-writer`. An OpenCode lane is always
  a writer. A Pi lane defaults to read-only and may request one writer. An OMP
  lane is read-only.
- A Pi writer lane requires at least one `ownedPaths` entry. Read-only lanes
  own no paths. Pi review lanes run no shell checks; OMP review lanes may run
  controller-owned checks.
- Pi and OMP lanes reject `agent` and `childAgents`.
- `childAgents` requires an explicit delegation-capable `agent` on an OpenCode
  lane.
- `dependsOn` names earlier or parallel plan lanes. The graph must be acyclic.
  A dependent lane starts after every named dependency completes and receives
  bounded dependency output and evidence.
- `ownedPaths` and `excludedPaths` stay relative to the lane's worktree.
- Every writer lane needs at least one check: lane `checks`, a shared `--check`,
  or `--no-check` on the command line. A shared `--check` appends to a writer
  lane's `checks`, Pi writers included, and to OMP read-only lanes. Pi review
  lanes remain shell-free.
- `--no-check` combines with neither `--check` nor lane `checks`.
- `--lane-spec` combines with neither a positional objective nor `--worker`,
  `--role`, `--route`, `--agent`, `--child-agent`, `--owned`, `--exclude`,
  `--timeout`, or `--cost-ceiling`. Declare each of those per lane.
- `--concurrency` defaults to the lane count capped at 8. A lane without
  `timeoutSeconds` gets 3600 seconds. The $0.25 report-only herd target divides
  across the lanes that declare no `costCeilingUsd`.
- Ready lanes run concurrently. Dependency-connected lanes run in order. A
  reviewer that reuses its writer's worktree is admitted against the writer's
  terminal workspace digest.
- A lane that returns a receipt whose enforced writer policy differs from the
  dispatched one fails reconciliation.
- Independent lane failures collect. `--failure-policy fail-fast` cancels the
  remaining lanes after the first one that does not complete.

`schemas/orchestration-plan.schema.json` holds the machine-readable shape.

## Pick a winner and land it

Read what every lane produced:

```bash
node scripts/ox_team.mjs report ORCHESTRATION_ID
```

The report gives each lane its `status`, `finalOutput`, `checks`,
`changedPaths`, `unownedChangedPaths`, `costReport`, and `configuredRoute`.
Compare those to choose a lane. A lane whose child receipt does not resolve
carries `error` and the bounded `finalOutputPreview` from the aggregate instead,
and sets the report's `reportStatus` to `partial`. Every other lane stays
complete.

Ask for an evidence-only proposal:

```bash
node scripts/ox_integrate.mjs propose ORCHESTRATION_ID
```

The proposal lists each lane's patch and base commit plus `overlaps`,
`conflictLaneIds`, `applyOrder`, and `unavailableLaneIds`. It changes nothing
and exits 2 when a lane overlaps another on a path or has no available patch.

Apply the selected lanes to a new integration worktree:

```bash
node scripts/ox_integrate.mjs apply ORCHESTRATION_ID \
  --lane LANE_A --lane LANE_B \
  --repo /absolute/path/to/repository \
  --check "npm test"
```

Apply creates a managed worktree at the selected lanes' shared base commit,
applies each patch with `git apply --index`, then runs the checks there. It
reports `integrated`, `checks-failed`, or `apply-failed` with the worktree path
and a cleanup command. Selected lanes must not overlap on a path and must share
one recorded base commit. Apply requires at least one `--check` or explicit
`--no-check`, and never writes to the source repository.

Export one lane's patch directly:

```bash
node scripts/ox_integrate.mjs export ORCHESTRATION_ID \
  --lane LANE_ID --out /absolute/path/to/lane.patch
```

Inspect the integration worktree and its check results before accepting the
changes.

## Inspect and repair

```bash
node scripts/ox_team.mjs list
node scripts/ox_team.mjs inspect ORCHESTRATION_ID
node scripts/ox_team.mjs retry ORCHESTRATION_ID --lane LANE_ID
node scripts/ox_orchestration.mjs archive ORCHESTRATION_ID \
  --out /absolute/path/to/fresh-evidence-directory
```

Retry only incomplete lanes. Preserve the effective route, agent, scope,
checks, timeout, cost target, worktree, and prior failed-check context.
Dependency-connected retries keep their order, receive the latest completed
upstream evidence, and reuse the newest upstream workspace digest.

Inspect a run or request cancellation:

```bash
node packages/cli/dist/main.js inspect RUN_ID
node packages/cli/dist/main.js cancel RUN_ID
node packages/cli/dist/main.js recover RUN_ID
```

Use `recover` only after the admitted process group has stopped. It releases a
held workspace lease and retains the recorded run evidence.

## Enforce the operating boundary

- Trusted-host OpenCode and Pi receive the access available to their installed
  launcher processes.
- Managed worktrees separate Git changes and provide no filesystem or network
  sandbox.
- `--owned` and `--exclude` classify Git-visible changes after execution.
- Trusted-host cost targets report observed cost after execution. They provide
  no hard provider spending cap.
- OMP claims only its qualified attested read-only macOS arm64 boundary.
- Keep authentication values out of route profiles, tasks, prompts, receipts,
  repositories, and documentation.

Read [OpenCode routes and work](references/opencode.md),
[Pi routes and work](references/pi.md),
[OMP routes and review](references/omp.md), and
[receipts and handoffs](references/receipts-and-handoffs.md) for details.
