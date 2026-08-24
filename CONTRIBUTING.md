# Contributing

Skills live at `skills/<name>/SKILL.md` per the
[Agent Skills spec](https://agentskills.io/specification).

- Run `python3 scripts/validate.py`, `python3 scripts/test_install_reviewed_pi.py`, `python3 scripts/test_setup.py`,
  `python3 scripts/test_guard_install.py`, `python3 scripts/verify_provenance.py`,
  `agentskills validate skills/ox-driver`, ShellCheck, Gitleaks,
  and `npm_config_registry=https://registry.npmjs.org npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list`
  before committing; CI runs them on every push and pull request.
- Follow the working and documentation rules in [CLAUDE.md](CLAUDE.md);
  they apply to human and agent contributors alike.
- Keep each SKILL.md body under 500 lines. Tighten existing text before
  appending new text.
- Verify flags and config keys against current tool docs; this repo tracks
  fast-moving software.
- New skills need a README entry describing what they add.
