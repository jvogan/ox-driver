# Pi and model setup

This guide targets Pi 0.84.3 and `stealth/ox-alpha` as observed on 2026-08-24.
Confirm the temporary route still appears in Pi's live catalog.

## Review and install

Use macOS or Linux, Node.js 22.20 or newer, Python 3.11+, npm, Bash, curl, and
ripgrep. Linux also needs bubblewrap and socat. Windows is not supported by the
guard. Compare live npm metadata with [versions.json](versions.json):

```bash
python3 scripts/verify_provenance.py
command -v pi || true
pi --version 2>/dev/null || true
python3 scripts/install_reviewed_pi.py
python3 scripts/install_reviewed_pi.py --install
OX_REAL_PI="${XDG_DATA_HOME:-$HOME/.local/share}/ox-driver/pi/0.84.3/dist/cli.js"
"$OX_REAL_PI" --version
```

Record the existing Pi executable and version in a private operator note. The
installer creates an isolated, versioned user installation and does not replace
raw Pi. Pass its exact executable to setup; keep any existing Pi distribution
available for unrelated work.

The installer downloads the fixed `@earendil-works/pi-coding-agent@0.84.3`
tarball only from the official npm registry and verifies its reviewed SHA-512.
The published shrinkwrap omits integrity for six Pi-family packages. The
installer separately downloads and verifies those six tarballs, fills their
reviewed SHA-512 values into an isolated copy, and runs `npm ci` directly in the
extracted package with lifecycle scripts disabled. npm verifies integrity for
every fetched package in the completed shrinkwrap; platform-omitted optional
packages are not fetched. The installer rejects unexpected identities, origins,
missing integrity, archive links, and existing destinations, including target
symlinks. These controls reduce npm risk; source review is still required before
trusting the packages.
Review package contents and release notes before upgrades. Pi's pinned
[security guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/packages.md)
explains why packages and extensions require source review.

Run `"$OX_REAL_PI"` and authenticate with `/login openrouter`. Prefer Pi's
protected auth store or a secret manager. Never place API keys in a repository,
`.env`, prompt, or Markdown note.

## Configure shared Pi behavior

Stop every active Pi root and child, then run one setup process at a time. A
running process retains settings and extensions that it loaded at startup.

```bash
python3 scripts/setup.py --pi-binary "$OX_REAL_PI" --dry-run
python3 scripts/setup.py --pi-binary "$OX_REAL_PI"
"$OX_REAL_PI" --list-models ox-alpha
```

The helper leaves raw Pi's default provider, model, and thinking level unchanged.
The protected `pi-ox` launcher forces Ox/max. Setup enables bounded request
recovery and gives compaction enough room for
Ox's large output allowance:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 196608,
    "keepRecentTokens": 65536
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": { "maxRetries": 0, "maxRetryDelayMs": 60000 }
  }
}
```

Pi may retry an empty provider response, but repeated identical calls are not a
recovery strategy. After retries are exhausted, inspect partial work and resume
with a short changed brief or wait before trying again.

It also sets `terminal.showImages` to `false`. Pi can still inspect image inputs,
but protected sessions do not ask the terminal application to display arbitrary
files. Re-enable terminal display only if the user wants that OS-level behavior.
Protected launches also cap cumulative provider-bound image history at 16 MiB
and four recent images. The extension replaces older image blocks with text in
the outgoing context without changing the saved transcript or source files.
Pi and its children can inspect PNG, JPEG, WebP, GIF, and BMP paths through the
read tool. BMP is converted internally; convert it to PNG first if that step
fails. Crop fine details before inspection. Pi does not attach video as video; extract
frames and inspect the images instead of using `@file` with a binary video.

It also adds the model's accepted reasoning map under
`providers.openrouter.modelOverrides.stealth/ox-alpha.thinkingLevelMap`:

```json
{
  "off": null,
  "minimal": null,
  "low": "low",
  "medium": null,
  "high": "high",
  "xhigh": null,
  "max": "max"
}
```

The helper preserves unrelated JSON keys, writes atomically, rejects symlink
targets, and backs up changed JSON. `PI_CODING_AGENT_DIR` or `--config-dir` can
point at a disposable directory for review.

Do not send the first model request yet. Install and test the guarded `pi-ox`
launcher in [ox-fleet.md](ox-fleet.md); the guard checks live zero pricing before
every uncached launch. This protection is useful even when subagents are not
installed.

## Confirm data terms before a live request

Read the [OpenRouter Stealth Program EULA](https://openrouter.ai/terms/stealth)
and [live model page](https://openrouter.ai/stealth/ox-alpha). The model page
says the provider retains prompts and completions but does not use them for
training; the governing EULA separately permits collection, retention, sharing,
training, evaluation, and improvement. Follow the broader rule. Stop unless the
user confirms the material is non-sensitive, they have the rights and consents
to submit it, and the first probe uses a disposable fixture.

## Verify the protected root

From an allowed project directory:

```bash
OX_PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
"$OX_PI_DIR/bin/pi-ox" -p --no-session --no-context-files --no-skills --tools bash \
  'Run this exact command and return only its output: printf "%s/%s %s" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"' \
  < /dev/null
```

Expect `openrouter/stealth/ox-alpha max`. The forced sandbox extension preserves
Pi's injected environment. A model's prose claim about its own reasoning level
is not evidence. Check the provider activity ledger for the route and charged
amount; reasoning-token columns may not report effort for this model.

## Roll back

Stop Pi first. The helper prints every backup name it creates. Compare the current
JSON with the selected `*.bak-<timestamp>-<pid>` file before restoring it; preserve
any newer unrelated settings. Ordinary install refuses differing guard or profile
assets. The explicit permission/network updater accepts only recognized owned
files and creates adjacent `*.bak-<timestamp>-<pid>` copies. Stop Pi, compare the
current asset with its backup, and restore only the intended file.

## Upgrade or remove the Agent Skill

The Agent Skill and installed Pi assets have separate lifecycles. For a global
Skills CLI installation, use the pinned CLI to preview and remove only
`ox-driver`, then reinstall from a reviewed checkout with the README's
`--global --copy` command. For a manual Codex or Claude installation, compare
the installed `ox-driver` directory with the reviewed replacement, move the old
directory to a private backup, and copy the complete replacement into the same
user-level skill directory. Removing the skill does not remove Pi settings,
launchers, sessions, or packages.

## Upgrade or remove Pi assets

There is no unattended Pi-asset upgrade or removal command. Stop every Pi
process and back up the agent directory. For an upgrade, keep a checkout of the
currently installed release and compare every installed owned file with that
release. Stop if any file was locally modified. Move the unchanged old assets,
preserving their relative paths, into a private timestamped backup directory.
Review provenance and release notes, merge only the documented owned JSON keys,
then run the new setup in `--dry-run` mode. The normal installer intentionally
refuses differing assets; it is not an upgrade flag.

For manual removal, remove only unchanged Ox Driver-owned files: `bin/pi-ox`,
`bin/pi-child`, `extensions/pi-safety.ts`, `extensions/pi-safety.json`,
`extensions/pi-resilience.ts`, `extensions/pi-image-budget.ts`,
`extensions/sandbox/`, `extensions/sandbox.json`,
`agents/pi-agent.md`, `agents/pi-lead.md`, and the `team`, `solo`, `team-smoke`,
and `team-acceptance` prompt files. Also remove
`extensions/subagent/config.json` only when Ox Driver created it and it is still
unchanged. Use real Pi's `remove npm:pi-subagents` command only when no other
workflow depends on that package. Restore pre-install JSON backups only when
they contain no newer unrelated changes; otherwise merge the original keys.

Inspect `cache/ox-driver-guard`, `subagent-sessions`, and adjacent
`*.bak-<timestamp>-<pid>` files. Remove the Ox cache with the guard. Remove
session transcripts or backups only after confirming that no other Pi workflow
needs them and the choice matches the user's retention policy.

Finally, stop Pi and move the isolated reviewed directory under
`${XDG_DATA_HOME:-$HOME/.local/share}/ox-driver/pi/0.84.3` to a private backup or
the platform trash. Raw Pi was not replaced. Verify `command -v pi` and
`pi --version`, then restart any remaining Pi sessions.

## Replace the model

Migration requires a controlled set of updates:

1. Review the replacement provider/model route, tools, reasoning support,
   availability, privacy, and price in Pi's live catalog.
2. Update the matching reasoning map and protected route constants. Raw Pi
   defaults remain the user's choice.
3. Update the fixed route and free-price or paid-budget policy in both launchers.
4. Add explicit spending approval before enabling a paid route.
5. Keep profiles on `model: inherit` and model scope on `allow: ["inherit"]`.
6. Rerun provenance, direct/child probes, scope and thinking failures, path and
   sandbox negatives, the selected capability test, and normal/solo regression.

The bundled helper is Ox-specific. Do not rerun it unchanged after migration.
When changing provider families, test forked lead context; use fresh context with
a complete brief if a fork loses reasoning or fails model resolution.
