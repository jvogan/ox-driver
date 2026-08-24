# Repository guide

Agent skills for driving fleets of ox-alpha max-reasoning workers on the Pi
coding agent. Each skill lives at `skills/<name>/SKILL.md` with optional
`references/` and `assets/` directories, per the
[Agent Skills spec](https://agentskills.io/specification).

## Working on this repo

- Run `python3 scripts/validate.py`, `python3 scripts/test_install_reviewed_pi.py`, `python3 scripts/test_setup.py`,
  `python3 scripts/test_guard_install.py`, `python3 scripts/verify_provenance.py`,
  `agentskills validate skills/ox-driver`, ShellCheck, Gitleaks,
  and `npm_config_registry=https://registry.npmjs.org npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list` after
  editing any SKILL.md. CI runs them.
- Keep each SKILL.md under 500 lines. Add `references/` files only when
  content outgrows the main file.
- Improve skills by replacing or tightening existing text. Appending grows
  load cost for every future invocation.
- Keep content machine-agnostic: no personal paths, account names, emails, or
  references to private tooling.
- Verify every CLI flag and config key against the current pi, pi-subagents,
  and OpenRouter docs before committing it. This repo documents fast-moving
  tools; a stale flag is worse than no example.
- `stealth/ox-alpha` is a temporary model ID. Content that depends on it must
  also say what to do when the ID stops resolving.

## Documentation rules

- Direct statements and imperatives. Every sentence carries information.
- Minimize em dashes, especially in the README; prefer colons, parentheses,
  commas, or separate sentences.
- No slogans or slogan-like phrasing.
- No rhetorical contrast structures ("it's not X, it's Y" / "X, not Y").
- No snark, sales language, defensive language, or obvious caveats.
- State the reason behind a rule when it's not evident; omit it when it is.
