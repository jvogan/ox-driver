# Guarded Pi agent teams

The protected topology is root `pi-ox` to `pi-lead` to `pi-agent`. A root may
also use flat `pi-agent` workers in normal mode. Raw `pi` remains separate.

## Choose child capability profiles

Choose before profile installation. A later change requires the explicit updater,
which accepts only recognized Ox Driver-owned files and creates backups.

| Capability profile | `pi-agent` | `pi-lead` | Controller responsibility |
|---|---|---|---|
| `power` | Nonsensitive home/project reads and file edits, search, bash | Same plus delegation | Review, Git, deletion, external mutations |
| `edit-only` | Project-scoped read, search, write, edit | Same plus delegation | Commands, tests, Git, deletion, external mutations |
| `review-only` | Project-scoped read and search | Same plus delegation | Every mutation and command |

All profiles inherit the protected model at max thinking, project instructions,
and skills. These profiles set child tool ceilings. The guard applies separate
command and path policies. The setup CLI keeps the `--permission-profile` name
for compatibility. Inherited context sends more data to the provider, so review
instruction files and the discovered skill catalog before use.

`power` is the full-capability default. Native file tools may work across
nonsensitive paths in the home, project, and temporary directories. Sandboxed
Bash stays workspace-scoped and writes only inside the project and temporary
directory. The selected network profile still governs Bash. Pi leaves
tool-approval policy to extensions. The guard asks about selected risky Bash
actions in an interactive root. Print and JSON modes have no confirmation UI, so
the same actions fail closed. Project-boundary and unlisted-domain violations
always block.

Choose bash network separately:

- `open`: full web access for research, downloads, APIs, and ordinary development.
  This is the recommended default for the full-power profile.
- `development`: npm, PyPI, and GitHub domains.
- `custom`: repeated user-approved `--allow-domain` values.
- `none`: no guarded root or child bash network.

The network rule applies to sandboxed Bash, not Pi's model connection. Open mode
preserves the filesystem sandbox but permits shell traffic to any destination.
The public extension reads only the user-level sandbox file, so an untrusted
project cannot widen this policy. A domain allowlist is not data-loss prevention:
power-mode Bash can encode data in a request to an allowed host. Keep `none` when
task data must not leave through shell commands. For web research, use `custom`
and include each search, forum, media, and source domain the task needs. An
omitted destination fails closed instead of opening an approval dialog.

## Install and test the guard

From the installed skill directory, stop every active Pi root and child before
running setup. A running process retains extension code that it loaded at startup.

```bash
OX_REAL_PI="${XDG_DATA_HOME:-$HOME/.local/share}/ox-driver/pi/0.84.3/dist/cli.js"
python3 scripts/setup.py --pi-binary "$OX_REAL_PI" --guard --acknowledge-stealth-terms --permission-profile power --network-profile open --dry-run
python3 scripts/setup.py --pi-binary "$OX_REAL_PI" --guard --acknowledge-stealth-terms --permission-profile power --network-profile open

OX_PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
(cd "$OX_PI_DIR/extensions/sandbox" && npm ci --ignore-scripts)
python3 scripts/test_guard.py --config-dir "$OX_PI_DIR"
```

For a conservative network profile, replace `open` with `development` or `none`.
For a custom policy, use
`--network-profile custom --allow-domain example.com` and repeat
`--allow-domain` as needed.

To change a tested installation later, preview and then apply one update:

```bash
python3 scripts/setup.py --update-permission-profile --permission-profile edit-only --dry-run
python3 scripts/setup.py --update-permission-profile --permission-profile edit-only
python3 scripts/setup.py --update-network-profile --network-profile development --dry-run
python3 scripts/setup.py --update-network-profile --network-profile development
```

Rerun the matching capability and sandbox acceptance tests after every change.

The helper installs portable copies under the Pi agent directory:

- `bin/pi-ox`: guarded root entry point.
- `bin/pi-child`: mandatory pi-subagents child entry point.
- `extensions/pi-safety.ts`: path gates, high-risk command policy, nested-agent
  denial, and route enforcement during guarded launches. It is inert when raw
  Pi discovers it without the launcher's guard marker.
- `extensions/pi-resilience.ts`: converts two empty, zero-usage provider
  anomalies into transient errors so Pi's bounded retry policy applies: an
  empty successful stop and the bare error text `ERROR`.
- `extensions/pi-image-budget.ts`: keeps cumulative provider-bound image
  history within 16 MiB and four recent images without changing the transcript.
- `extensions/pi-safety.json`: selects nonsensitive home scope for `power` and
  project scope for the conservative profiles.
- `extensions/sandbox/`: Pi's bash sandbox, patched to preserve Pi's execution
  environment and fail bash closed when initialization fails.
- `extensions/sandbox.json`: network and filesystem policy.

Setup adds the resolved Pi auth-store path to the sandbox policy, including when
`PI_CODING_AGENT_DIR` points somewhere other than the default directory.

The launchers pin the reviewed real Pi path, reject `/`, home, configuration and
credential directories, pass only an explicit environment allowlist, verify that
every advertised price is zero plus tools/max support with a locked 60-second
catalog cache, force the reviewed extensions, and export
`PI_SUBAGENT_PI_BINARY` plus a guard-ready marker. Child working directories must
remain under the root project or in a linked Git worktree with the same canonical
common directory. The public Ox launcher fails when the route becomes paid; a
future paid route needs an explicit budget implementation before it is allowed.
The cache lock records its owner and recovers automatically after an interrupted
launch. Proxy and custom-CA variables are preserved for both catalog checks and
Pi. The protected launcher rejects `--approve`; review and trust project files
interactively before starting protected work.

The helper verifies Pi's package name, version, and `bin.pi` identity. Pass the
isolated reviewed package executable with `--pi-binary`; do not pass a policy
wrapper from `PATH`.

The bash sandbox defaults to open network and project-plus-temporary writes. It
scans the project at startup and denies discovered credential-like files. The
in-process `pi-safety` extension separately canonicalizes paths, enforces the
selected file-tool scope, and blocks sensitive paths.
Headless risky commands fail closed; the child can report the blocked action
through `contact_supervisor`.

`test_guard.py` is offline. It checks launcher syntax and modes, required files,
the sandbox dependency, environment forwarding, guard markers, path-policy
invariants, root/child model rejection, low-thinking rejection, and home-cwd
rejection. The live acceptance sequence below proves runtime behavior.

## Install pi-subagents and profiles

Verify the values in [versions.json](versions.json), then use the exact package:

```bash
npm view pi-subagents@0.56.0 dist.integrity
OX_REAL_PI="${XDG_DATA_HOME:-$HOME/.local/share}/ox-driver/pi/0.84.3/dist/cli.js"
npm_config_ignore_scripts=true "$OX_REAL_PI" install npm:pi-subagents@0.56.0
python3 scripts/setup.py --pi-binary "$OX_REAL_PI" --fleet --permission-profile power --dry-run
python3 scripts/setup.py --pi-binary "$OX_REAL_PI" --fleet --permission-profile power
```

Fleet setup and each protected launch require the installed npm lock entry to
match the reviewed version and SHA-512 registry integrity in `versions.json`.

Replace `power` with `edit-only` or `review-only` when selected. Do not use
`npx pi-subagents`; it follows a moving Git branch. The pinned
[configuration](https://github.com/nicobailon/pi-subagents/blob/v0.56.0/docs/configuration.md),
[agent](https://github.com/nicobailon/pi-subagents/blob/v0.56.0/docs/agents.md),
and [model](https://github.com/nicobailon/pi-subagents/blob/v0.56.0/docs/models.md)
references describe this release.

The settings addition is:

```json
{
  "subagents": {
    "defaultThinking": "max",
    "maxThinking": "max",
    "modelScope": {
      "enforce": true,
      "strict": true,
      "allow": ["inherit"]
    }
  }
}
```

Fleet installation writes `maxSubagentDepth: 2` and a short
`defaultSessionDir` to `extensions/subagent/config.json`. The depth setting is
the package's native cap. The session path keeps nested background snapshot
identifiers below Pi's session-id length limit without changing ordinary root
session storage. The launcher independently requires the same depth through its
child environment.

Protected launchers disable ambient extension discovery. They load only
`pi-safety`, the sandbox, the verified `pi-subagents@0.56.0` entry, and the two
package-internal child runtime extensions it emits. This prevents a duplicate
`subagent` provider or unrelated extension code from entering the protected
process. Raw Pi still discovers the user's normal extensions. Trusted project
settings can replace user model scope, so the independent launcher validation is
defense in depth. Ambient `pi-safety` remains inert in raw Pi and activates only
when `pi-ox` or `pi-child` supplies the guard marker.

The reviewed native depth is 2 and cumulative run-tree admission is 64. Session
spawn and active-run limits are unlimited unless configured. Put an explicit
ceiling in every task; a bounded asynchronous wave may launch all admitted
children at once.

Start `"$OX_PI_DIR/bin/pi-ox"` in a project and run `/subagents-doctor` and
`/subagents-models`.

## Launch patterns

Always use `agentScope: "user"`; project profiles otherwise win collisions.
Protected mode allows only the installed `pi-agent` and `pi-lead` names and
blocks `workflowScript` and subagent management actions. Direct calls accept
only `agent`, `agentScope`, `task`, `async`, `context`, and `worktree`.

One child:

```js
subagent({
  agent: "pi-agent",
  agentScope: "user",
  async: false,
  task: "Read-only: do not edit, modify, write, or touch files. Map the auth flow with file:line evidence."
})
```

One parallel wave uses separate direct calls:

```js
subagent({
  agent: "pi-agent",
  agentScope: "user",
  async: true,
  task: "Read-only: do not edit, modify, write, or touch files. Review correctness; cite file:line."
})
subagent({
  agent: "pi-agent",
  agentScope: "user",
  async: true,
  task: "Read-only: do not edit, modify, write, or touch files. Review test coverage; cite file:line."
})
subagent_wait({all: true})
```

Check every launch result before waiting and call `subagent_wait` once rather
than polling. It may return early for attention or timeout; treat missing or
failed receipts as unresolved. If all children completed before the wait
registered, it can report nothing active; use delivered notifications and
durable receipts, then verify artifacts. Use `async: false` for a single
blocking child.

Parallel `power` or `edit-only` writers require `worktree: true` and disjoint
ownership. This is the intentional exception that lets pi-subagents create and
remove managed Git worktrees inside the guarded current repository; arbitrary
child `cwd` overrides are blocked. A dirty checkout gets one writer. Worktrees
prevent collisions; they are not a security boundary.

The `power` profile permits general Bash inside the selected workspace. Use
Pi's native file tools for allowed cross-folder reads and edits; the sandbox
keeps Bash reads workspace-scoped and confines writes to the project and
temporary directory. Command checks catch common Git, deletion,
publishing, and nested-agent forms, but they cannot infer every equivalent
program. Use `edit-only` or `review-only` when shell denial must be mechanical.
The controller must still review the diff and working tree.
The configured Pi agent directory is denied to every native file tool and to
sandboxed Bash, including when a custom agent directory sits inside the project.

## Modes

- Normal: a plain prompt lets Pi work directly or request flat workers.
- Team: `/team <task>` requests bounded direct lead calls; each lead may make
  bounded direct leaf calls.
- Solo: `/solo <task>` instructs Pi not to delegate. Add
  `--exclude-tools subagent` when this must be mechanically enforced.

Prompt templates express policy. The tool and launcher controls provide the hard
boundaries.

## Acceptance sequence

`/team-smoke <small project question>` is the minimum activation workflow. Its
expected range is five to nine model calls and it stays read-only. Run the steps
below before allowing writing teams. `/team-acceptance <disposable fixture path
and capability profile>` packages the expensive checks and always stops for
topology approval because it is expected to exceed ten calls.

Run in order and stop at the first mismatch:

1. `scripts/test_guard.py`, package provenance, `/subagents-doctor`, and
   `/subagents-models`.
2. Direct `pi-ox` bash probe for exact `PI_PROVIDER`, `PI_MODEL`, and
   `PI_REASONING_LEVEL`; expect `openrouter/stealth/ox-alpha max`.
3. One child with the same probe plus its loaded extensions and working directory.
4. For `power`, use a native file tool to read a nonsensitive file from another
   home-directory project, fetch a public URL, write inside the fixture, and run
   a deterministic test. Confirm Bash cannot read that sibling file.
   Confirm sensitive reads and out-of-home paths still fail. For a conservative
   profile, confirm the same cross-project file-tool read fails.
5. Deliberate out-of-scope and low-thinking launches that fail before a child
   model call.
6. In a disposable project, prove bash writes cannot escape except to the
   approved temporary area, and prove bash cannot reach an unapproved domain.
7. One lead with two explicitly read-only agents; verify reports and clean Git.
8. One capability test matching the capability profile: full implementation and
   deterministic tests for `power`, edit-plus-root-test for `edit-only`, or
   evidence-only review for `review-only`.
9. One native depth-3 attempt that fails. Prove bash cannot start Pi, Claude,
   Codex, OpenCode, or clear `PI_SUBAGENT_*` state.
10. One worktree-isolated writing pair when the profile permits edits.
    In `review-only`, request `worktree: true` and verify that it fails before
    any branch or worktree state changes.
11. One blocked Git/deletion action reported to the supervisor, then normal and
    enforced-solo regression.
12. One synthetic capability failure that produces a failed receipt or
    `CAPABILITY_BLOCKED`, followed by controller takeover and successful resume.
13. Read a cropped image in both a root and child. Extract frames from a small
    video and inspect those frames; never pass video bytes through `@file`.
14. Feed a mocked context more than 16 MiB of image history. Verify that the
    provider view keeps the newest images within budget and the transcript hash
    remains unchanged.

A team can exceed ten model calls because tool results create turns. Disclose
the topology and expected range first. Use explicit read-only wording; never
waive a failed status for a writing task.
