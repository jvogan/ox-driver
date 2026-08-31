# Pi routes and work

Pi provides trusted-host solo writing and solo read-only review through an
explicit route profile. Ox Driver preserves the selected provider, model,
reasoning effort, launcher, and configured network behavior.

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

Use values supported by the installed Pi launcher. Add `--expected-version`
or `--expected-sha256` when a task requires an exact launcher identity. The
profile stores no authentication value.

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
write tools. Ox Driver excludes delegation tools and requests a solo run.

Owned and excluded paths classify Git-visible changes after execution. They do
not restrict launcher access. Run a writer in a disposable worktree appropriate
for the launcher's host access.

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

## Use Pi in composition

A herd lane plan may include a Pi read-only reviewer. The lane runs
independently in its own admitted snapshot and cannot declare shell checks.
Shared herd checks apply to writer lanes.

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

Ox Driver supports no Pi child or team topology. A request for Pi children or
teams must remain visible as unsupported.

## Boundary

Pi receives the filesystem, process, and network access available to the
installed launcher. The writer uses its normal task tools. The reviewer uses a
controller read policy without an OS sandbox. Reported cost is telemetry after
execution and provides no hard spending cap.
