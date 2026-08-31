# Contributing

Ox Driver accepts changes that improve supported dispatch, receipts, recovery,
documentation, or adapter inspection without weakening route and capability
checks.

## Set up the repository

```bash
npm ci --ignore-scripts
npm run build
npm test
```

The test suite makes no model request. Add fixture coverage for each changed
admission, rejection, receipt, cancellation, or recovery path.

## Preserve the capability contract

- OpenCode supports one-writer tasks, receipt-aware direct children, pairs,
  herds, retries, and explicit integration.
- Pi supports solo one-writer tasks and solo read-only review.
- OMP supports attested solo read-only review on the qualified macOS arm64
  route.
- ACP and DeepSeek Harness support inspection only and reject task dispatch.

Do not claim Pi children or teams, OMP writing or children, ACP dispatch, or
DeepSeek Harness dispatch. Add executable coverage before expanding a
capability claim.

## Keep route policy explicit

Keep harness commands, flags, protocol parsing, and version probes inside their
adapters. Keep provider, model, reasoning, launcher, and agent policy in route
profiles.

A retry must preserve the recorded route-profile digest. An additional lane or
stronger model requires the user's approval when it changes the selected route
or cost scope.

## Write machine-neutral documentation

- Use generic absolute paths, profile names, and agent names in examples.
- Keep authentication values, prompts, transcripts, repository content, and
  real run identifiers out of committed files.
- Describe only behavior covered by code and tests.
- Use direct statements and imperatives.
- Keep detailed harness setup in its harness reference.
- Keep each `SKILL.md` body under 500 lines.

Validate skill changes with:

```bash
agentskills validate skills/ox-driver
npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list
```

Run Gitleaks on committed content before opening a pull request. Include the
user-visible outcome, the boundary affected by the change, and the commands
used for verification.
