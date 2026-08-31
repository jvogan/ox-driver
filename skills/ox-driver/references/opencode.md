# OpenCode routes and work

OpenCode provides trusted-host one-writer tasks, receipt-aware direct children,
pairs, and herds. Managed worktrees separate Git changes and remain available
for inspection.

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

The primary profile must expose OpenCode's task delegation tool. Each child
profile must pass the route and writer-policy checks. Every child inherits the
primary provider, model, and reasoning effort.

Ox Driver records the observed direct child graph after execution. It rejects
route drift, unexpected profiles, grandchildren, incomplete child metadata,
and direct write tools on a declared read-only child. A shell-capable child can
still change files, so changed paths remain aggregate to the parent worktree.

## Run a pair or herd

Create one managed worktree per writer:

```bash
node scripts/ox_workspace.mjs create /absolute/path/to/repository
node scripts/ox_workspace.mjs create /absolute/path/to/repository

node scripts/ox_pair.mjs "Implement two independent approaches" \
  --worker /absolute/path/to/worktree-a \
  --worker /absolute/path/to/worktree-b \
  --check "npm test"
```

`ox_herd.mjs` accepts two to 32 lanes and an optional `--concurrency` value.
Each lane gets its own objective, worktree, route, agent, scope, checks,
timeout, and reported-cost target through a lane plan.

Pair and herd collect independent failures by default. Select fail-fast only
when the remaining lanes must stop after one failure. Roles label lanes; they
do not share changes. Use handoff for ordered writer and reviewer work.

## Boundary

OpenCode runs with the filesystem and network access of its installed launcher.
The route profile preserves provider, model, reasoning effort, and agent policy.
Reported cost is telemetry after execution. Use launcher-side or provider-side
limits when a task requires a hard spending cap.
