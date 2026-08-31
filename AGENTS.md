# Repository guidance

Ox Driver dispatches repository work to OpenCode, Pi, and OMP. ACP and
DeepSeek Harness adapters provide zero-model inspection only and reject every
task dispatch.

## Capability contract

- OpenCode supports one-writer tasks, receipt-aware direct children, pairs,
  team lanes, dependencies, retries, and explicit integration.
- Pi supports one-writer tasks and read-only review as solo runs or team lanes.
  Integration accepts Pi writer patches from orchestration receipts.
- OMP supports attested read-only review as a solo run, team lane, or handoff
  reviewer on a qualified macOS arm64 route.
- A team may use any combination of OpenCode, Pi, and OMP lanes.
- Ox-managed Pi child-profile selection is unavailable.
- OMP writing and child agents are unavailable.
- ACP and DeepSeek Harness task dispatch is unavailable.

Keep this contract aligned across the adapter registry, route profiles, CLI,
orchestration plans, retry plans, README, skill, package manifest, and tests.
A capability change requires executable coverage for its admitted and rejected
paths.

## Development rules

- Run `npm test` after changing controller code, schemas, profiles, adapters,
  scripts, or documentation examples.
- Keep adapter discovery model-free. An inspection-only adapter must report
  `executionQualified: false` and reject preflight.
- Preserve the selected harness, launcher, provider, model, reasoning effort,
  agent profile, scope, checks, timeout, and reported-cost target.
- Preserve worker turns, tools, child capacity, context, output, and wrap-up
  time unless the user requests a bound or the controller enforces one.
- Keep collect-all behavior for independent lanes unless the user selects
  fail-fast.
- Report unavailable topology or capability without substituting a weaker
  workflow.
- Keep credentials outside route profiles, tasks, prompts, receipts,
  repositories, and documentation.
- Keep examples machine-neutral. Use generic absolute paths, route names, and
  agent names.
- Use synthetic identifiers in tests and examples.

## Documentation rules

- Use direct statements and imperatives.
- Put the result or condition first.
- Name the actor and the object.
- Make every capability claim testable against code or a receipt contract.
- Use one term for each harness, route, workflow, and receipt field.
- Describe shipped behavior in present tense.
- Avoid slogans, rhetorical contrasts, sales language, and repeated summaries.
- Keep detailed harness setup in its harness reference.
- Keep `skills/ox-driver/SKILL.md` under 500 lines.

Before committing a skill change, run:

```bash
npm ci --ignore-scripts
npm test
agentskills validate skills/ox-driver
npm_config_ignore_scripts=true npx --yes skills@1.5.23 add . --list
```
