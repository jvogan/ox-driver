# OMP routes and review

OMP provides attested solo read-only review on the qualified macOS arm64 route.
Ox Driver claims no OMP writer, child-agent, Linux, or unqualified macOS mode.

## Prepare a route

Choose dedicated OMP agent and home directory paths. The route initializer
creates them with owner-only permissions when they do not exist. Keep only the
files required by the selected route in those directories. Configure the installed OMP launcher for
ephemeral RPC operation with ambient extensions, skills, rules, MCP, memory,
background work, eval, and session persistence disabled.

Create the route profile:

```bash
npm run build
node scripts/ox_route.mjs init-omp \
  --launcher omp \
  --provider PROVIDER \
  --model MODEL \
  --reasoning EFFORT \
  --agent-dir /absolute/path/to/omp-agent \
  --home-dir /absolute/path/to/omp-home \
  --expected-version EXPECTED_VERSION \
  --expected-sha256 EXPECTED_SHA256
node scripts/ox_route.mjs check --id omp-default
node packages/cli/dist/main.js doctor omp
```

Use the version and digest for the qualified launcher. `doctor omp` checks the
launcher, route profile, RPC contract, isolated directories, tool inventory,
and process-containment mechanism without making a model request.

When the provider requires an environment value, add the corresponding name
with `--env NAME`. The profile records the name. Supply its value only to the
controller process that runs the review.

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

The adapter exposes only read, grep, and glob operations. It verifies the
configured route and allowed tools before and after the prompt, records usage
and configured-price cost telemetry, checks process cleanup, and requires zero
Git-visible changes.

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

## Boundary

The qualified route uses a pinned OMP launcher, isolated runtime directories,
a read-only tool inventory, and process-bound macOS containment. Its configured
network path remains available for provider traffic. Destination identity is
not a claimed boundary.

Writing, child agents, other operating systems, and other containment-mechanism
digests require separate qualification and remain unavailable through this
adapter.
