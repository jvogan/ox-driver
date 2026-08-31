# OpenCode routes and work

OpenCode is a third-party command-line coding agent. Ox Driver runs the
installed `opencode` launcher with an explicit `--model provider/model`,
`--variant EFFORT`, and an optional `--agent` profile.

OpenCode provides trusted-host one-writer tasks, receipt-aware direct children,
pairs, and team lanes. Managed worktrees separate Git changes and remain
available for inspection.

## Create a route

Build Ox Driver, then create an explicit route profile:

```bash
npm run build
node scripts/ox_route.mjs init-opencode \
  --launcher opencode \
  --provider PROVIDER \
  --model MODEL \
  --reasoning EFFORT
node scripts/ox_route.mjs check --id opencode-default
npm exec -- ox-driver-opencode doctor
```

Use provider, model, and reasoning values supported by the installed launcher.
The initializer validates profile shape. The first paid task verifies that the
launcher can reach the selected route.

Use `--agent PROFILE` to set a default OpenCode agent. Use `--id PROFILE_ID`
and `--route PROFILE_ID` when keeping several reviewed routes. Keep a route
profile unchanged while active or retryable runs reference its digest.

## Run one writer

```bash
npm exec -- ox-driver-opencode task /absolute/path/to/repository \
  "Implement one focused change and report the result" \
  --route opencode-default \
  --owned . \
  --check "npm test"
```

The command creates a detached managed worktree from `HEAD`. Uncommitted and
ignored files in the source checkout do not appear in that worktree. Choose
checks that run in a fresh checkout, or tell the worker to install required
dependencies.

Repeat `--owned` to list expected output paths. Repeat `--exclude` to fail when
a named path changes. These options classify Git-visible changes after the
worker returns. They do not restrict reads or writes.

Use `--no-check` only when no executable acceptance command applies. Ox Driver
preserves the worktree after completion and never merges it automatically.

## Allow direct children

```bash
npm exec -- ox-driver-opencode task /absolute/path/to/repository \
  "Implement one focused change; delegate independent research when useful" \
  --route opencode-default \
  --agent primary-agent \
  --child-agent research-agent \
  --owned . \
  --check "npm test"
```

The primary profile must expose OpenCode's task delegation tool. Every child
inherits the primary provider, model, and reasoning effort.

Preflight probes each child profile and rejects one that overrides the
inherited model, selects a different reasoning effort, or enables the `write`,
`edit`, or `patch` tool inside a one-writer task.

After execution, Ox Driver reconstructs the observed direct child graph from
OpenCode's session records and fails the receipt on an unadmitted route, an
unadmitted agent profile, a grandchild, a child outside the root workspace
identity, or incomplete parent lineage. This reconciliation runs after
execution and detects disallowed delegation. A
shell-capable child can still change files, so changed paths remain aggregate
to the parent worktree.

When OpenCode does not expose the primary agent's runtime identity, the receipt
records `agentIdentity.runtimeObservation.status: "unavailable"`. The receipt
still records the configured route and agent profile.

## Run a pair or team

Create one managed worktree per writer:

```bash
node scripts/ox_workspace.mjs create /absolute/path/to/repository
node scripts/ox_workspace.mjs create /absolute/path/to/repository

node scripts/ox_pair.mjs "Implement two independent approaches" \
  --worker /absolute/path/to/worktree-a \
  --worker /absolute/path/to/worktree-b \
  --check "npm test"
```

`ox_team.mjs run PLAN.json` accepts two to 32 lanes. Each lane declares its
harness; an OpenCode-only plan needs no Pi or OMP installation. Plans may mix
OpenCode with Pi and OMP, run independent branches concurrently, and order
stages with `dependsOn`. `skills/ox-driver/SKILL.md` carries the plan example
and lane rules; `schemas/orchestration-plan.schema.json` is the
machine-readable shape.

Herd defaults: `--concurrency` is the lane count capped at 8, a lane without
`timeoutSeconds` gets 3600 seconds, and the $0.25 report-only herd target
divides evenly across the lanes that declare no `costCeilingUsd`. Pair defaults
to a $0.10 report-only target. Both targets are telemetry compared after
execution.

Pair and team runs collect independent failures by default. Select
`--failure-policy fail-fast` when the remaining lanes must stop after one
failure. Roles label lanes. Use `dependsOn` for staged work and handoff for the
specialized OpenCode-writer-to-reviewer workflow.

## Boundary

OpenCode runs with the filesystem and network access of its installed launcher.
The route profile preserves provider, model, reasoning effort, and agent policy.
Reported cost is telemetry after execution. Use launcher-side or provider-side
limits when a task requires a hard spending cap.
