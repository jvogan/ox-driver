# Third-party notices

The sandbox extension in `skills/ox-driver/assets/extensions/sandbox/index.ts`
is derived from the sandbox example shipped with Pi coding agent 0.84.3:

- Source: https://github.com/earendil-works/pi/tree/v0.84.3/packages/coding-agent/examples/extensions/sandbox
- License: MIT
- Copyright (c) 2025 Mario Zechner

Ox Driver adds fail-closed behavior and forwards Pi's execution context and
environment through the replacement bash tool.

The complete upstream MIT notice is bundled with the installed skill in
`skills/ox-driver/THIRD_PARTY_NOTICES.md`.

The sandbox extension depends on `@anthropic-ai/sandbox-runtime` 0.0.73:

- Source: https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.73
- License: Apache-2.0
- Copyright: Anthropic, PBC
