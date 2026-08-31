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
checks, timeout, and reported-cost target. A retry uses the recorded route
profile and fails when its digest changes.

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
| Compare independent implementations | OpenCode pair or herd |
| Review an admitted snapshot without changes | Pi solo read-only review or OMP attested review |
| Review completed OpenCode changes | Handoff with Pi or OMP as reviewer |
| Inspect an installed ACP or DeepSeek Harness adapter | Zero-model `doctor`; task dispatch stays blocked |

OpenCode supports solo writing, direct children, pairs, and herds.
Pi supports solo writing and solo read-only review. OMP supports attested solo
read-only review on the qualified macOS arm64 route.

Ox-managed Pi children and teams are unavailable. OMP writing and child agents
are unavailable. ACP and DeepSeek Harness task dispatch is unavailable.

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
Use `--no-check` only when no executable acceptance command applies.

Allow native OpenCode delegation only when the selected primary and child
profiles passed route and tool-policy checks:

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

The Pi writer requires at least one owned path and uses the installed launcher's
normal tool surface. The reviewer uses the controller's read-only tool policy.
Pi dispatch remains solo through Ox Driver.

## Run an OMP review

```bash
node packages/cli/dist/main.js omp-review \
  /absolute/path/to/repository \
  "Review this repository for correctness risks" \
  --route omp-default \
  --no-check
```

OMP review is ephemeral, solo, read-only, and limited to the qualified macOS
arm64 route. Add one or more `--check` arguments when executable acceptance
applies. Do not combine `--check` with `--no-check`.

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

## Run a pair or herd

Create one managed worktree per OpenCode writer:

```bash
node scripts/ox_workspace.mjs create /absolute/path/to/repository
node scripts/ox_workspace.mjs create /absolute/path/to/repository

node scripts/ox_pair.mjs "Implement two independent approaches" \
  --worker /absolute/path/to/worktree-a \
  --worker /absolute/path/to/worktree-b \
  --check "npm test"
```

Use `ox_herd.mjs` for two to 32 lanes. Use a lane plan when workers need
different objectives, routes, agents, scopes, checks, timeouts, or cost targets.
A lane plan may include a Pi read-only reviewer. That reviewer sees its admitted
snapshot. Use handoff when review must follow completed writer work.

Pair and herd preserve every child run identifier and produce one aggregate
receipt. They never merge worker changes.

## Inspect and repair

```bash
node scripts/ox_orchestration.mjs list
node scripts/ox_orchestration.mjs inspect ORCHESTRATION_ID
node scripts/ox_orchestration.mjs report ORCHESTRATION_ID
node scripts/ox_orchestration.mjs retry ORCHESTRATION_ID --lane LANE_ID
node scripts/ox_orchestration.mjs archive ORCHESTRATION_ID \
  --out /absolute/path/to/fresh-evidence-directory
```

Retry only incomplete lanes. Preserve the effective route, agent, scope,
checks, timeout, cost target, worktree, and prior failed-check context.

Inspect a run or request cancellation:

```bash
node packages/cli/dist/main.js inspect RUN_ID
node packages/cli/dist/main.js cancel RUN_ID
node packages/cli/dist/main.js recover RUN_ID
```

Use `recover` only after the admitted process group has stopped. It releases a
held workspace lease and retains the recorded run evidence.

## Propose and integrate work

Start with an evidence-only proposal:

```bash
node scripts/ox_integrate.mjs propose ORCHESTRATION_ID
```

Apply explicitly selected, non-conflicting lanes to a new integration worktree:

```bash
node scripts/ox_integrate.mjs apply ORCHESTRATION_ID \
  --lane LANE_A --lane LANE_B \
  --repo /absolute/path/to/repository \
  --check "npm test"
```

Inspect the integration worktree and checks before accepting its changes.

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
