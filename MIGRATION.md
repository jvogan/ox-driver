# Migrating from Ox Driver 1.x

Ox Driver 2.0.0-dev.0 replaces the retired Ox Alpha/Pi fleet product with an
OpenCode controller. It is a source preview and has no in-place upgrade
command. Historical 1.x code remains available in Git history and should not
be reused with a replacement model route.

## Before installing 2.0

1. Stop active `pi-ox`, `pi-child`, `/team`, and `/solo` sessions.
2. Keep a copy of the 1.x checkout at the version you installed.
3. Back up the Pi agent directory at
   `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` and any installed `ox-driver`
   skill.
4. Install 2.0 from a separate extracted directory and configure a new
   OpenCode route profile.

Version 2.0 ignores the old Pi assets. It does not remove Pi packages,
launchers, settings, extensions, agents, prompts, caches, sessions, or backups.
Your raw `pi` command remains independently usable. Existing 1.x assets may
coexist with the 2.0 controller while you review the new workflow.

## State and receipts

Version 2.0 stores route profiles under `~/.config/ox-driver/routes` by default.
Run, orchestration, and managed-worktree records use `~/.local/state/ox-driver`
by default. You can isolate them with `OX_DRIVER_STATE_DIR`,
`OX_DRIVER_ORCHESTRATION_STATE_DIR`, and `OX_DRIVER_WORKSPACE_STATE_DIR`.

There is no 1.x receipt import. Keep any historical evidence you need before
removing old files.

## Optional 1.x cleanup

Cleanup is optional. Stop every Pi process first. Compare installed files with
the 1.x checkout and remove only unchanged Ox Driver-owned files. Move files to
a private backup or the platform trash so the operation remains recoverable.
Never delete or move the whole Pi agent directory. Preserve user settings,
authentication, unrelated extensions, agents, prompts, sessions, caches, and
backups unless the user makes a separate retention decision.

The 1.x installer owned these paths beneath the Pi agent directory:

- `bin/pi-ox` and `bin/pi-child`
- `extensions/pi-safety.ts` and `extensions/pi-safety.json`
- `extensions/pi-resilience.ts` and `extensions/pi-image-budget.ts`
- `extensions/sandbox/` and `extensions/sandbox.json`
- `agents/pi-agent.md` and `agents/pi-lead.md`
- `prompts/team.md`, `prompts/solo.md`, `prompts/team-smoke.md`, and
  `prompts/team-acceptance.md`

Remove `extensions/subagent/config.json` only when Ox Driver created it and the
file is unchanged. Remove `pi-subagents` only when no other workflow depends on
that package. Restore a pre-install JSON backup only when it contains no newer
unrelated settings; otherwise merge the original keys manually.

The 1.x installer modified owned keys in `models.json` and `settings.json`.
Restore or merge those keys from the pre-install backup after comparison. Never
delete either whole file.

Review `cache/ox-driver-guard`, `subagent-sessions`, and adjacent
`*.bak-<timestamp>-<pid>` files separately. Preserve `subagent-sessions`,
caches, and backups unless the user makes a separate retention decision.

The isolated reviewed Pi directory was stored under
`${XDG_DATA_HOME:-$HOME/.local/share}/ox-driver/pi/0.84.3`. Move that exact
directory only after confirming the installed version and stopping Pi. Then
verify that `command -v pi` and `pi --version` still resolve the raw Pi
installation you intend to keep.

## Install the 2.0 skill

After extracting and reviewing this release, inspect the skill with the pinned
Skills CLI:

```bash
npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list
```

Install through your host agent's normal skill workflow, or copy the complete
`skills/ox-driver` directory into its user-level skills directory. Keep the
release directory available because the skill invokes scripts from that tree.
