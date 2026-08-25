# Drive Pi from Claude Code or Codex

Any controller that can run a subprocess can delegate to Pi. The controller is
responsible for the overall result; each Pi root owns its assigned work package
and Pi children.

## Choose the entry point

- Plain prompt: Pi works directly or chooses zero to several flat `pi-agent`
  workers when delegation helps.
- `/team <task>`: request the depth-2 lead-and-agent hierarchy.
- `/solo <task>`: instruct Pi not to delegate. Add `--exclude-tools subagent`
  when that must be enforced rather than prompted.

The controller chooses the mode and supplies hard bounds. A useful brief includes
the objective, working directory, owned paths, exclusions, writer policy,
verification command, maximum leads and agents, and report format.

## Dispatch one root

Use a goal ID limited to letters, digits, dots, underscores, and hyphens. Store
reports outside the target checkout, or first confirm that the checkout ignores
the output directory. Close stdin on every scripted call:

```bash
OX_PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
OX_GOAL_ID="goal-123"
case "$OX_GOAL_ID" in *[!A-Za-z0-9._-]*|'') exit 2 ;; esac
OX_RUN_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ox-driver/runs"
umask 077
mkdir -p "$OX_RUN_DIR"
chmod 700 "$OX_RUN_DIR"
"$OX_PI_DIR/bin/pi-ox" -p --session-id "$OX_GOAL_ID" "$(cat goal.md)" \
  < /dev/null > "$OX_RUN_DIR/$OX_GOAL_ID.md" \
  2> "$OX_RUN_DIR/$OX_GOAL_ID.err"
```

Pi print mode merges stdin into the prompt. An inherited stdin handle that never
reaches end-of-file can leave a process waiting with no output; `< /dev/null`
removes that failure mode. Use `--mode json` for newline-delimited progress
events.

Print and JSON modes cannot answer extension confirmation dialogs. When the
guard matches a risky Bash action, the action fails closed. Let the Pi worker
finish its coding task and report the blocked action. The controller can then
review the diff and perform an authorized Git, deletion, publishing, deployment,
or external mutation through its normal user-approval path.

## Recover a failed capability

Treat a nonzero Pi exit, failed child receipt, or missing final output as
incomplete. Inspect the error and resulting files before deciding what remains.
Print mode returns a nonzero exit after an exhausted provider error; JSON mode
also exposes the final error event.

Recover at the nearest healthy layer:

- An active child reports `CAPABILITY_BLOCKED`, the artifact path, exact error,
  attempted recovery, and remaining work through `contact_supervisor`.
- A Pi root returns `CONTROLLER_ACTION_REQUIRED` when the outside Codex, Claude,
  or other controller must supply a capability or inspect an artifact.
- A lead may retry one transient child failure. Another child on the same model
  route is not independent redundancy. After bounded empty-response retries are
  exhausted, resume with a short changed recovery brief or retry later; do not
  loop the identical request.
- Pi roots and children can inspect image paths through the read tool. Crop a
  region of interest when small text matters. Pi 0.84.3 constrains image input
  to 2000 by 2000 pixels and about 4.5 MB of base64 payload.
- Pi accepts PNG, JPEG, WebP, GIF, and BMP. BMP is converted internally; if
  conversion fails, convert it to PNG before dispatch. Crop regions with fine
  text instead of relying on automatic downscaling.
- The guarded launcher rejects command-line `@file` arguments. Put the image
  path in the task brief and tell the Pi root or child to use its read tool.
- Pi has no video attachment path. Extract representative frames with a local
  media tool and pass the image paths. Never use `@file` with video or another
  binary; Pi may treat unsupported bytes as text and produce a confident but
  fabricated analysis.
- If image calls continue to fail at the provider, the external controller may
  inspect the image with its approved vision tool and resume the same
  `--session-id` with a concise description.
- A cumulative-image 413 means the session history is too large for the
  provider. Restart Pi after installing the image-budget extension, then resume
  the session. Do not repeat `continue` or `/compact` against the same unguarded
  history.
- Apply the same pattern when the controller has another required local
  capability. Do not silently change the provider, model, privacy terms, cost,
  or authorization boundary.

For an advanced interactive bridge, run Pi in
[RPC mode](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/rpc.md#extension-ui-protocol)
and implement the extension UI protocol. A confirmation arrives as an
`extension_ui_request`; return an `extension_ui_response` with the same ID only
after presenting the exact command and reason to the user. General task approval
does not authorize an external mutation.

`--session-id` stores a local transcript and tool output. Use `--no-session` for
ephemeral work. Review retention and remove obsolete run/session artifacts using
the host's normal private-data cleanup process.

For an ephemeral read-only scout, remove bash and mutation tools:

```bash
"$OX_PI_DIR/bin/pi-ox" -p --no-session --tools read,grep,find,ls \
  "Read-only: map the authentication flow with file:line evidence." \
  < /dev/null
```

Tool restriction reduces accidental mutation; it is not OS containment. Start in
the narrowest relevant directory and keep sensitive data out of the prompt.

## Dispatch a team

After the fleet and child guard pass their acceptance tests:

```bash
"$OX_PI_DIR/bin/pi-ox" -p --session-id "$OX_GOAL_ID" "/team $(cat goal.md)" \
  < /dev/null > "$OX_RUN_DIR/$OX_GOAL_ID.md" \
  2> "$OX_RUN_DIR/$OX_GOAL_ID.err"
```

The root launches each lead with a direct structured `subagent` call containing
`agent: "pi-lead"`, `agentScope: "user"`, and a focused `task`. Protected mode
blocks `workflowScript` because nested scripts can override user-only agent
discovery. Use `async: false` for one blocking lead. For a parallel wave, make a
bounded set of direct calls with `async: true`, then use `subagent_wait` once
with `all: true`. A wait can return early for attention or timeout; missing and
failed receipts remain unresolved.
Put exact bounds in the brief, for example: "At most two leads, at most two
agents per lead, one writer total."

If the expected run exceeds ten model calls, the root reports its topology and
stops. Approve or narrow the plan on the same session:

```bash
"$OX_PI_DIR/bin/pi-ox" -p --session-id "$OX_GOAL_ID" \
  "Approved, with one lead and two agents maximum." < /dev/null
```

The controller is the approver in this headless two-turn flow. Approval covers
only the disclosed topology. It does not approve unrelated external mutations.

## Parallel roots

An external controller may start several independent Pi roots. Give each root a
non-overlapping work package. Multiple readers may share a checkout. Use managed
worktrees or scratch clones for parallel writers, and never put two writers in
the same tree.

The controller must not call `pi-child` or raw Pi for protected work. Start
`pi-ox`; it routes pi-subagents through the child launcher.

## Brief template

```markdown
# Objective
<one bounded outcome>

# Scope
Own: <paths>
Do not touch: <paths>
Writer policy: <read-only, one writer, or managed worktrees>
Topology ceiling: <leads and agents>

# Acceptance
Run: <deterministic command>
Report: <files, evidence, command output, open issues>
```

For a no-edit lane, include the exact sentence: "Read-only: do not edit, modify,
write, or touch files."

## Collect and verify

A worker report is a claim. Inspect the diff, rerun the acceptance command, and
check the working tree before accepting it.

To prove route and effort, require the worker to run:

```bash
printf '%s/%s %s' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"
```

Expect the configured provider/model and reasoning level. Do not rely on a
model's self-report. The protected launcher rejects `--no-extensions`. If an
extension replaces bash, use the reviewed real Pi package executable with
`--no-extensions` only in a disposable, non-sensitive diagnostic directory, then
repair context/environment forwarding before protected work.

Continue the same session for a small correction. Rewrite the brief and start a
fresh session when the approach or ownership split was wrong.

## Concurrency

Set an explicit ceiling in every wave: direct asynchronous calls may all launch
concurrently, while the reviewed cumulative run-tree admission cap is 64. Start
with a small measured wave, watch errors and account usage, and raise external
parallelism only after it completes cleanly. Workflow size, run-tree size,
provider rate limits, account budgets, and the ten-call approval policy are
separate constraints; satisfying one does not waive the others.
