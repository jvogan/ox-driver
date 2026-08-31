# Repository guidance

Ox Driver dispatches repository work to OpenCode, Pi, and OMP. ACP and
DeepSeek Harness adapters provide zero-model inspection only and reject every
task dispatch.

## Capability contract

- OpenCode supports one-writer tasks, receipt-aware direct children, pairs,
  herds, retries, and explicit integration.
- Pi supports solo one-writer tasks and solo read-only review. A Pi review lane
  may join a herd or review completed OpenCode work in a handoff.
- OMP supports attested solo read-only review on the qualified macOS arm64
  route. It may review completed OpenCode work in a handoff.
- Ox-managed Pi children and teams are unavailable.
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
