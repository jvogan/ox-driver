# Contributing

Skills live at `skills/<name>/SKILL.md` per the
[Agent Skills spec](https://agentskills.io/specification). The public preview
supports the OpenCode trusted-host lane on macOS and Linux.

- Run `npm ci --ignore-scripts` and `npm test` before committing. CI builds and
  tests the supported contract on macOS and Linux.
- Validate the skill with `agentskills validate skills/ox-driver` using
  `skills-ref==0.1.1`.
- Scan committed content with Gitleaks and confirm discovery with
  `npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list`.
- Keep provider/model policy in route profiles. Do not commit credentials,
  prompts, transcripts, private repository content, or machine-specific paths.
- Keep each SKILL.md body under 500 lines. Tighten existing text before
  appending new text.
- Verify flags and config keys against current tool docs; this repo tracks
  fast-moving software.
- New public capabilities need a README entry, fixture coverage, and a receipt
  contract that survives process failure and recovery.
