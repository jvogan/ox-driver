# Pi routes and work

Pi is a third-party command-line coding agent. Ox Driver runs the installed
`pi` launcher with an explicit provider, model, and reasoning selection, and
sets its session, tool, extension, and skill flags per run.

Pi provides trusted-host writing and read-only review through an explicit
route profile. Run either mode alone, in a Pi-only team, or in a mixed team.
Ox Driver preserves the selected provider, model, reasoning effort, launcher,
and configured network behavior.

## Create a route

```bash
npm run build
node scripts/ox_route.mjs init-pi \
  --launcher pi \
  --provider PROVIDER \
  --model MODEL \
  --reasoning EFFORT
node scripts/ox_route.mjs check --id pi-default
node packages/cli/dist/main.js doctor pi
```

Use values supported by the installed Pi launcher. Add `--expected-version` to
require that text in the launcher's version output, or `--expected-sha256` to
require that exact launcher digest. The profile stores no authentication value.

`doctor pi` checks the launcher, version constraint, digest constraint, route
profile, and adapter contract without making a model request. Dispatch requires
an execution-qualified doctor result.

## Run a solo writer

```bash
node scripts/ox_pi.mjs /absolute/path/to/repository \
  "Implement one focused change and report the result" \
  --route pi-default \
  --writer \
  --owned . \
  --check "npm test"
```

A Pi writer requires at least one owned path. It receives the installed
launcher's normal extensions, skills, repository context, shell, edit, and
write tools. Ox Driver excludes delegation tools inside that lane and rejects
OpenCode-style `--agent` selection. Team composition happens at the Ox lane
level.

Owned and excluded paths classify Git-visible changes after execution. They do
not restrict launcher access.

Ox Driver creates no managed worktree for a Pi writer. `ox_pi.mjs` resolves the
repository argument and passes it to the run as the working directory, so the
writer edits that directory in place. Create the disposable worktree yourself
before dispatch:

```bash
node scripts/ox_workspace.mjs create /absolute/path/to/repository
```

The command prints JSON containing the new worktree's `id` and `path`. Pass
that `path` to `ox_pi.mjs`.

## Run a solo review

```bash
node scripts/ox_pi.mjs /absolute/path/to/repository \
  "Review this repository for correctness risks" \
  --route pi-default
```

The read-only path starts an ephemeral solo session. It disables write and
command-execution tools, project context files, saved approval, skills, prompt
templates, and session persistence. A controller extension confines built-in
read operations to the admitted repository and rejects declared exclusions.

The direct trusted-host route adds no OS sandbox. Use a disposable repository
snapshot without unrelated sensitive content.

## Use Pi in a team

A team may contain only Pi lanes or mix Pi with OpenCode and OMP. Set
`"harness": "pi"` on each Pi lane. Pi lanes default to read-only; add
`"writerPolicy": "one-writer"`, `ownedPaths`, and checks for a writer.

Use `dependsOn` to order research, writing, review, and synthesis. A dependent
lane receives bounded output and receipt evidence from its dependencies. An
ordered reviewer may reuse the writer's worktree and is admitted against the
writer's terminal workspace digest.

Plan validation rejects `checks` on a Pi review lane and rejects `agent` and
`childAgents` on every Pi lane. Shared checks reach Pi writers and skip Pi
reviewers.

Use a handoff when Pi must review completed OpenCode changes:

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

Ox does not select native Pi child profiles inside a lane. Use additional Pi
lanes when the task needs more workers under one aggregate receipt.

Pi team-writer receipts include patch evidence, so `ox_integrate.mjs` can
propose, export, and apply selected Pi changes with controller-owned checks.

## Boundary

Pi receives the filesystem, process, and network access available to the
installed launcher. The writer uses its normal task tools. The reviewer uses a
controller read policy without an OS sandbox. Reported cost is telemetry after
execution and provides no hard spending cap.
