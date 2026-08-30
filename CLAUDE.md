# Repository guidance

Ox Driver 2.0.0-dev.0 is an OpenCode-only source preview. Keep the public tree
self-contained and machine-agnostic. Do not add private paths, credentials,
prompts, transcripts, run IDs, or unpublished harness code.

Preserve the operator-selected launcher, provider, model, reasoning effort,
agent profile, scope, checks, timeout, and reported-cost target. Preserve model
turns, reasoning, tools, child capacity, context, output, and wrap-up time.
Tighten a limit only when the user requests it or a controller policy requires
it.

Keep runtime refusals tied to concrete unsupported behavior. Add assurance work
with the capability it enables. Public claims must match receipt evidence and
fixture coverage.

Before committing controller, schema, route, or documentation changes, run:

```bash
npm ci --ignore-scripts
npm test
agentskills validate skills/ox-driver
npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list
```

Use direct, checkable prose. Keep retired product details confined to
`CHANGELOG.md` and `MIGRATION.md`.
