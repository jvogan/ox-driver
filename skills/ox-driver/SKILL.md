---
name: ox-driver
description: >-
  Launch and manage fleets of full-capability OpenRouter ox-alpha agents at max
  reasoning through Pi. Use the harness directly in Pi or drive it from Claude
  Code or Codex. Use for guided installation, direct or parallel agent work,
  pi-agent/pi-lead orchestration, capability and network choices, headless
  dispatch, acceptance testing, and route migration.
license: MIT
metadata:
  version: "1.0.1"
---

# Ox Driver

Set up Pi so a coding assistant can run Ox Alpha directly or manage several
full-capability agents at max reasoning. Keep ordinary raw Pi available. Use
`pi-ox` for protected model work and all team launches.

## First-use interview

When the harness is not installed, inspect the existing Pi configuration before
writing. First explain that the anonymous provider receives and retains the
selected prompt, parent context, project instructions, skills, and tool results.
The Ox page says those records are not used for training, while the governing
Stealth EULA authorizes collection, sharing, retention, training, evaluation,
and improvement. Require confirmation that the material is non-sensitive and
the user has the rights and consents to submit it. Then ask the user to choose
these two boundaries:

| Choice | Options |
|---|---|
| Child capability | `power` (recommended): full coding tools plus nonsensitive cross-folder access; `edit-only`: project-scoped file editing without bash; `review-only`: project-scoped reading without mutation or bash |
| Sandboxed bash network | `open` (recommended): full web access; `development`: npm, PyPI, and GitHub; `custom`: user-approved domains; `none`: no shell network |

Explain that all profiles keep Ox/max, inherited project instructions and skills,
and supervisor access. Git, deletion, and external mutations are assigned to the
controller by prompt policy and best-effort command matching; they are not a
complete OS-level boundary.
`power` permits nonsensitive native file-tool work across the home and temporary
directories; guarded Bash stays workspace-scoped and writes only to the project
and temporary directory. A fixed denylist blocks common credential paths but
cannot classify content or cover every secret. The two conservative
profiles keep file tools inside the project and mechanically remove bash or all
mutation tools. The setup CLI keeps `--permission-profile` for compatibility.

Pi leaves tool-approval policy to extensions. The guard prompts only for selected
risky Bash actions in an interactive root. Print and JSON modes have no
confirmation UI, so risky actions fail closed. Headless children report blocked
work to the supervisor. Path and restricted-network violations always block. The
conservative profiles mechanically narrow child tools.

Routine reads, searches, writes, edits, commands, tests, and allowed network
requests do not prompt in `power`. A denied cross-folder Bash read should be
retried with a native file tool, not submitted for approval.
Native `power` file tools may overwrite non-denylisted home files without a
prompt. A broad native search is blocked when the target tree contains a known
credential path; narrow the path, or use sandboxed Bash inside the project.

Explain that `open` makes research and ordinary development work without
pre-enumerating sites, but shell commands can send project data anywhere.
Restricted allowlists reduce destinations but do not prevent exfiltration to an
allowed host.

Stop every active Pi root and child before installing, updating, rolling back,
or removing extension assets. A running process retains loaded extension code.
Preview with `scripts/setup.py --dry-run`. Never silently replace a conflicting
profile, extension, wrapper, or settings shape.
Pass `--acknowledge-stealth-terms` to the guard installer only after the user
accepts the disclosure above. The protected launcher checks the recorded
acknowledgement for plain, solo, team, and controller-driven runs.

Later changes use `--update-permission-profile` or `--update-network-profile`.
Preview first. The updater accepts only recognized Ox Driver-owned assets and
backs up each changed file.

## Route the work

- Read [pi-setup.md](references/pi-setup.md) for Pi installation, authentication,
  model configuration, supply-chain checks, privacy, rollback, and migration.
- Read [ox-fleet.md](references/ox-fleet.md) for guard installation, child
  capability profiles, pi-subagents, launch patterns, and acceptance tests.
- Read [driving-from-outside.md](references/driving-from-outside.md) when Claude
  Code, Codex, or another process controls Pi headlessly.
- Use [versions.json](references/versions.json) before any install or upgrade.

## Non-negotiable controls

1. Pin packages and verify their registry integrity. Never use the moving
   `npx pi-subagents` installer.
2. Install and test `pi-ox`, `pi-child`, `pi-safety`, and the bash sandbox before
   installing full team profiles. Start protected work only through `pi-ox`.
3. Keep `modelScope` strict with `allow: ["inherit"]`; use
   `agentScope: "user"` for installed roles.
4. Use one writer in a dirty checkout and managed worktrees for parallel writers.
   The controller reviews diffs and performs approved Git or external mutations.
5. State no-edit tasks exactly: "Read-only: do not edit, modify, write, or touch
   files." Verify the report and working tree.
6. Before a run likely to exceed ten model calls, disclose route, topology,
   writers, worktrees, and expected range; obtain approval before launch.

## Controller policy

- Plain prompt: let Pi work directly or use zero to several flat `pi-agent`
  workers when a useful split exists.
- `/team <task>`: request the depth-2 lead-and-agent hierarchy through direct
  structured calls with `agentScope: "user"`; protected mode blocks
  `workflowScript` because nested scripts can override discovery scope.
- `/solo <task>`: instruct Pi not to delegate. Add `--exclude-tools subagent`
  when the restriction must be mechanical.
- Give every root and child a bounded objective, owned paths, exclusions,
  topology ceiling, and verification command.
- Close stdin on scripted calls with `< /dev/null`; reuse `--session-id` only
  when local transcript persistence is intended.
- After an image-budget notice, use cropped images or a contact sheet instead
  of rereading many full-size images.
- In print or JSON mode, let guarded risky actions fail closed. Have the
  controller perform an authorized Git, deletion, publishing, deployment, or
  external mutation after it reviews the child report.
- For intentionally asynchronous waves, make bounded direct child calls with
  `async: true`, then use `subagent_wait` once. Do not poll.
- Treat a nonzero headless exit, failed child receipt, or missing final output as
  incomplete. Inspect the error and files before accepting the run.
- Follow the media and exhausted-retry recovery procedure in
  [driving-from-outside.md](references/driving-from-outside.md).

## Completion gate

Run the offline tests, then `/team-smoke <question about a disposable,
non-sensitive fixture>` as the minimum activation gate. Before writing-team use,
run `/team-acceptance <disposable fixture
and capability profile>` with explicit approval. Stop at the first mismatch. Use
Pi's `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` values as route evidence;
do not trust model self-reports.
