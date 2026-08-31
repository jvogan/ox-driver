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

The test suite makes no model request. It runs the shipped scripts and CLIs as
child processes against fixture launchers, temporary state directories, and
throwaway Git repositories.

Add fixture coverage for each changed admission, rejection, receipt,
cancellation, or recovery path. Every shipped command already has a test that
executes it. Extend the matching test:

| Command surface | Test |
|---|---|
| `scripts/ox_route.mjs` | `tests/controller/ox-route-script.test.mjs` |
| `scripts/ox_opencode.mjs` | `tests/controller/ox-opencode-script.test.mjs` |
| `scripts/ox_pi.mjs` | `tests/controller/ox-pi-script.test.mjs` |
| `scripts/ox_omp.mjs` | `tests/controller/ox-omp-script.test.mjs` |
| `scripts/ox_workspace.mjs` | `tests/controller/managed-worktrees.test.mjs` |
| `scripts/ox_pair.mjs` | `tests/controller/ox-pair-script.test.mjs` |
| `scripts/ox_herd.mjs` | `tests/controller/ox-herd-script.test.mjs` |
| `scripts/ox_team.mjs` | `tests/controller/ox-team-script.test.mjs` |
| `scripts/ox_orchestration.mjs` | `tests/controller/ox-orchestration-script.test.mjs` |
| `scripts/orchestration-retry.mjs` | `tests/controller/orchestration-retry.test.mjs` |
| `scripts/ox_integrate.mjs` | `tests/controller/ox-integrate-script.test.mjs` |
| `packages/opencode-cli` | `tests/controller/opencode-public-cli.test.mjs` |
| `packages/cli` runtime | `tests/controller/cli-runtime.test.mjs` |

Add or update a direct CLI parsing test when changing
`packages/cli/src/main.ts`.

## Preserve the capability contract

- OpenCode supports one-writer tasks, receipt-aware direct children, pairs,
  team lanes, dependencies, retries, and explicit integration.
- Pi supports one-writer tasks and read-only review as solo runs or team lanes.
  Integration accepts Pi writer patches from orchestration receipts.
- OMP supports attested read-only review as a solo run or team lane on a
  qualified macOS arm64 route.
- Teams may use any combination of OpenCode, Pi, and OMP lanes.
- ACP and DeepSeek Harness support inspection only and reject task dispatch.

Do not claim Ox-managed Pi child profiles, OMP writing or children, ACP
dispatch, or DeepSeek Harness dispatch. Add executable coverage before
expanding a capability claim.

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
