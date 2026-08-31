# OMP routes and review

OMP is a third-party command-line coding agent with a JSON-RPC mode. Ox Driver
runs the installed `omp` launcher with `--mode rpc` and a read-only tool
inventory.

OMP provides attested read-only review on a qualified macOS arm64 route. Run it
alone, as a dependency-ordered team lane, or as a handoff reviewer. OMP
writing, child agents, Linux, and unqualified macOS modes are unavailable.

## Prepare a route

Choose dedicated OMP agent and home directory paths. `init-omp` creates them
with owner-only permissions when they do not exist. Keep only the files the
selected route requires in those directories.

Create the route profile:

```bash
npm run build
node scripts/ox_route.mjs init-omp \
  --launcher omp \
  --provider PROVIDER \
  --model MODEL \
  --reasoning EFFORT \
  --agent-dir /absolute/path/to/omp-agent \
  --home-dir /absolute/path/to/omp-home
node scripts/ox_route.mjs check --id omp-default
node packages/cli/dist/main.js doctor omp
```

`doctor omp` checks the launcher, route profile, RPC contract, isolated
directories, tool inventory, and process-containment mechanism without making a
model request.

When the provider requires an environment value, add the corresponding name
with `--env NAME`. The profile records the name. Supply its value only to the
controller process that runs the review.

## Expected launcher identity

The adapter expects OMP version `18.0.6`. On macOS arm64 it also expects the
launcher SHA-256 published as `ompPinnedRelease.darwinArm64Sha256` from
`packages/adapters/omp`. Both values are defaults inside the adapter, so a
route profile that omits `--expected-version` and `--expected-sha256` uses them.

`doctor omp` hashes the launcher before executing it and reports
`compatibility: blocked` in three cases:

- The digest differs from the expected digest. `probe.artifact` is `drifted`.
- The platform is not macOS arm64 and the profile supplies no expected digest.
  `probe.artifact` is `unverified`.
- The launcher reports a version other than the expected version. The probe
  records an `OMP version drift` notice.

The first two cases run no version command, RPC command, prompt, or model call.

Pass `--expected-version` and `--expected-sha256` to `init-omp` to pin a
different build. Each supplied value replaces the corresponding adapter
default for every run that uses the profile. The receipt then proves which
build ran. Ox Driver's published attested qualification remains scoped to
18.0.6 and its documented digest.

## Run a review

```bash
node packages/cli/dist/main.js omp-review \
  /absolute/path/to/repository \
  "Review this repository for correctness risks" \
  --route omp-default \
  --no-check
```

Use one or more `--check` arguments when executable acceptance applies. Use
`--no-check` when the review report is the complete deliverable. The command
rejects a combination of `--check` and `--no-check`.

The adapter exposes only the `read`, `grep`, and `glob` tools. It launches OMP
with session persistence, ambient extensions, skills, and rules disabled, and
with a generated configuration overlay that turns off memory, project MCP
configuration, and eval. It verifies the configured route and allowed tools
before and after the prompt, records usage and configured-price cost telemetry,
checks process cleanup, and requires zero Git-visible changes.

## Review completed OpenCode work

```bash
node packages/cli/dist/main.js handoff \
  /absolute/path/to/repository \
  "Implement one focused change" \
  --owned . \
  --builder-route opencode-default \
  --reviewer omp \
  --reviewer-route omp-default \
  --check "npm test"
```

The controller binds OMP to the writer's Git-visible digest. It rejects a
workspace change between writer completion and reviewer admission. Acceptance
commands run after the reviewer returns and must preserve the same Git-visible
state except for admitted writer changes.

## Use OMP in a team

Set `"harness": "omp"` and `"writerPolicy": "read-only"` on an OMP lane. Use
`dependsOn` when it must inspect a completed writer. Reuse the writer's
worktree to bind admission to that lane's terminal digest, or give OMP a
separate worktree for an independent review. OMP lanes may declare
controller-owned checks and may be retried from their aggregate receipt.

## Boundary

The qualified route uses a pinned OMP launcher, isolated runtime directories,
a read-only tool inventory, and process-bound macOS containment. Its configured
network path remains available for provider traffic. Destination identity is
not a claimed boundary.

Writing, child agents, other operating systems, and other containment-mechanism
digests require separate qualification and remain unavailable through this
adapter.
