# Migrating to Ox Driver 2.0

Ox Driver 2.0 uses explicit route profiles for OpenCode, Pi, and OMP. Install
it in a separate source directory, create current profiles, and verify each
selected harness with its zero-model doctor before dispatch.

The Ox Alpha route is retired and cannot dispatch work. Ox Driver 2.0 does not
import earlier receipts or reuse retired route configuration.

## Install 2.0

```bash
npm ci --ignore-scripts
npm run build
```

Create only the route profiles you plan to use:

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

Add `--expected-version` or `--expected-sha256` when the route requires an
exact launcher. Add repeated `--env NAME` arguments to the OMP initializer for
the environment-variable names admitted to that process. Route profiles never
store the corresponding values.

Validate profiles and installed harnesses:

```bash
node scripts/ox_route.mjs check --id opencode-default
node scripts/ox_route.mjs check --id pi-default
node scripts/ox_route.mjs check --id omp-default
node packages/cli/dist/main.js doctor --all
```

Remove a check command for a profile you did not create. Keep earlier source
and receipt directories until you have retained the records required by your
own data policy.

## State and receipts

Version 2.0 stores route profiles in the configured Ox Driver route directory.
Run, orchestration, checkpoint, and managed-worktree records use the configured
state roots. Version 2.0 reads no earlier receipt format into a new run.

Inspect current worktrees and orchestration records before removing any earlier
state. Remove only the exact directories you have reviewed and selected.

## Workflow changes

- Use an OpenCode managed task for one isolated writer.
- Use a Pi solo writer when the selected Pi route fits the task.
- Use Pi or OMP for read-only review.
- Use handoff when Pi or OMP must review completed OpenCode changes.
- Use pair or herd for independent OpenCode lanes.
- Use explicit integration after inspecting lane receipts and patches.

Read the README and the harness reference for the selected route before the
first paid dispatch.
