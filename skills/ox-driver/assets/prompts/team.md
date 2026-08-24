---
description: Orchestrate a full built-in coding lead-and-agent team
argument-hint: "<task>"
---

Orchestrate an agent team for: $ARGUMENTS

Before any child launch, use bash to confirm `OX_DRIVER_GUARD_READY=1`. Stop if
the check fails. The protected launcher validates every child invocation before
starting it.

Before launching, state the proposed leads, agents per lead, writer and worktree
plan, model route, and expected model-call range. If the run is likely to exceed
ten model calls, stop and obtain approval. Do not launch if the task, parent
conversation, project instructions, or inherited skills contain data the selected
provider is not approved to receive.

Launch each bounded, non-overlapping lead with a direct `subagent` call using
`agent: "pi-lead"`, `agentScope: "user"`, and a focused `task`. Do not use
`workflowScript`. Use `async: false` for one blocking lead. For a parallel lead
wave, make bounded direct calls with `async: true`, then use `subagent_wait`
with `all: true`. A wait can return early for attention or timeout; treat every
missing or failed receipt as unresolved. Direct calls may contain only `agent`,
`agentScope`, `task`, `async`, `context`, and `worktree`.
Leads may launch `pi-agent` leaves. Use managed worktrees for parallel writers and one
writer in a dirty checkout. The root owns integration and verification. The
human-facing controller is assigned deletions, Git state, publishing,
deployment, and external mutations. That assignment is agent policy plus
best-effort command matching, not complete OS-level containment.

Treat every failed or missing child receipt as unresolved work. Retry one
transient child failure at most. If an external controller must inspect an
artifact or supply a missing capability, return `CONTROLLER_ACTION_REQUIRED`
with the artifact path, exact error, attempted recovery, and remaining work.

Describe every no-edit lane as: "Read-only: do not edit, modify, write, or touch
files." Verify its report and the working tree rather than relying on status text
alone.
