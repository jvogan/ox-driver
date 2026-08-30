# OpenCode controller operation

Build the public controller before its first use:

```bash
npm ci --ignore-scripts
npm run build
node packages/opencode-cli/dist/main.js doctor
```

The command surface is:

```bash
node packages/opencode-cli/dist/main.js validate run-spec.json
node packages/opencode-cli/dist/main.js doctor
node packages/opencode-cli/dist/main.js preflight run-spec.json
node packages/opencode-cli/dist/main.js run run-spec.json
node packages/opencode-cli/dist/main.js inspect RUN_ID
node packages/opencode-cli/dist/main.js cancel RUN_ID
node packages/opencode-cli/dist/main.js recover RUN_ID
```

`doctor` defaults to OpenCode and makes zero model calls. It resolves the user
route directory first, followed by the bundled ambient profile. Set
`OX_DRIVER_ROUTE_PROFILE_DIR` to an absolute directory for a separate profile
store, `OX_DRIVER_OPENCODE_PROFILE` to select its default profile, and
`OX_DRIVER_STATE_DIR` to select an isolated run-state directory.
Supervisors may set `OX_DRIVER_REQUESTED_RUN_ID` to a canonical UUID before
`run`; the CLI emits the same ID to stderr before dispatch. Inspect, cancel, and
recover use controller state directly and remain available when route profiles
are missing.

Create an explicit route profile for dispatch:

```bash
node scripts/ox_route.mjs init-opencode \
  --launcher opencode --provider PROVIDER --model MODEL --reasoning REASONING
node scripts/ox_route.mjs check
```

The route profile contains no credentials. OpenCode continues to use its own
installed authentication and normal tools. Dispatch passes the exact explicit
provider, model, and reasoning fields to OpenCode and binds their canonical
digest into the receipt. A configured agent profile is also passed through and
recorded. In 2.0.0-dev.0, solo JSON events do not identify the primary agent or
prove the runtime route, so solo receipts record the configured values and
state that runtime observation is unavailable. Flat runs use OpenCode DB
metadata to record the observed primary profile, child profiles, and exact
route.

Route profiles are operator-selected pins. Host language such as “stronger,”
“better,” “try another agent,” or “retry” does not authorize replacing the
provider, model, reasoning effort, launcher, or agent. Use another reviewed
profile only after the user explicitly requests or approves its route. Never
edit a profile in place to change an active or retrying orchestration.

RunSpecs use version 1, `trusted-host`, harness `opencode`, session `new`,
network `configured`, and writer policy `read-only` or `one-writer`. Topology
may be `solo` or `flat`; flat requires explicit allowed child profiles and
one exact inherited route, allows zero or more direct children, and rejects
grandchildren. The selected primary must expose OpenCode's native task tool;
one-writer runs also reject child profiles with direct write/edit tools. The
`routeProfile` field is required. Provider-call, tool-call, child, and
hard-spend limits remain unsupported because the current OpenCode transport
cannot admit them before execution. `reportOnlyCostUsdMicros` records the
operator's telemetry expectation.

Receipt-aware flat child sessions require the launcher's zero-model
`opencode db` command. The root session ID comes only from this run's structured
stream. After process exit, Ox Driver performs two identical bounded DB queries
and reconciles the primary session, child sessions, task-call edges, exact
profiles and routes, terminal states, provider turns, tool calls, token totals,
and cost. The query records whether the root objective equals the requested
objective. Prompt, reasoning, and tool input/output text are excluded. A
normalized artifact and digest are preserved with the run. Because this is
post-run evidence,
`limits.children`, `limits.providerRequests`, `limits.toolCalls`, and
`limits.spend` remain false.

Acceptance commands run after valid harness completion under controller-owned
process handling. They use `/bin/sh -c` inside the task directory with private
HOME, temporary, and XDG directories. Provider credentials and ambient Git
configuration are removed from that acceptance environment. Each command's
exit status and workspace changes appear in the receipt.

`inspect` reads durable status and receipt evidence. `cancel` records a
cancellation request and terminates a durably admitted process group when the
original controller is gone. `recover` releases a held terminal fallback
workspace only after the controller proves every admitted process exited.

Trusted-host OpenCode has normal host filesystem access and the launcher's
configured network access. Use a disposable, secret-free worktree for writers,
review its diff, and integrate selected changes manually.

For work requiring distinct lane settings, pass `--lane-spec FILE` to
`scripts/ox_herd.mjs`.
The version-1 plan contains from two to 32 lanes. Each lane declares a unique
ID, role, objective, absolute worker path, and optional route, agent, change
scope, checks, timeout, and reported-cost expectation. Ox validates the entire
plan before allocating an orchestration ID or starting a worker. Shared
`--check` values append to every lane's checks.

Omitted `harness` values and explicit `opencode` values select the OpenCode
writer runner. Other harness values are rejected before allocation. Herd lanes
run concurrently in distinct worktrees and never inspect each other's changes.

`node scripts/ox_orchestration.mjs report ID` restores each child's retained,
bounded terminal output and bounded acceptance-output previews from the durable
run store. The child receipt path retains the complete captured acceptance
record. Report exits 2 with a valid partial report when any child receipt is
unavailable.

Task, pair, and herd aggregates created by this version retain a digest-bound
effective lane snapshot. Continue one incomplete lane with
`node scripts/ox_orchestration.mjs retry ID --lane LANE_ID`. Continue every
failed, blocked, or unknown lane with `node scripts/ox_herd.mjs --retry-failed
ID`. Retry reuses the exact managed worktree, route, agent, scopes, checks,
timeout, and reported-cost target. It passes bounded failed-check stdout and
stderr to the continuation and reruns the checks. Completed sibling lanes keep
their existing receipts and do not run again. A new immutable retry receipt
records the full attempt chain and the unresolved root lanes.
