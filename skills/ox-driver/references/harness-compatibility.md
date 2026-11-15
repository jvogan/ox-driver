# Harness compatibility

Compatibility reference checked on 2026-11-15. Upstream release numbers identify
available harness releases. Ox Driver qualifies the protocol and enforcement
contracts described below. A version or digest pin preserves launcher identity;
it does not qualify a new protocol.

## OpenCode

Ox Driver uses the OpenCode V1 JSON event stream for one-writer tasks. Direct
child receipts additionally require the `opencode-db-v1` metadata contract and
two stable DB snapshots. A launcher without that DB contract can run solo tasks;
it cannot provide qualified direct child receipts.

Doctor blocks recognized OpenCode major versions 2 and later before optional
launcher doctor commands or DB probes. An exact version or digest pin does not
bypass this boundary. The `opencode-v2` adapter ID versions the Ox Driver
adapter contract; it does not claim OpenCode 2 compatibility. Ox Driver
preserves the selected provider, model, reasoning effort, and route when it
reports the block.

The upstream packages identify different release lines: `opencode-ai` is
1.19.5, while `@opencode/cli` is 2.3.0. Both expose an `opencode` command.
OpenCode V2 changes server and plugin contracts, permission actions, and
subagent behavior. V2.3.0 makes subagents run in the background by default.
These contracts require separate adapter coverage before dispatch is admitted.

Sources: [V1 package](https://registry.npmjs.org/opencode-ai/latest),
[V2 package](https://registry.npmjs.org/@opencode%2fcli/latest),
[official installation](https://opencode.ai/docs/),
[V1 migration](https://opencode.ai/docs/migrate-v1/), and
[V2.3.0 release](https://github.com/anomalyco/opencode/releases/tag/v2.3.0).

## Pi

Pi's current package is `@earendil-works/pi-coding-agent`, version 1.5.2.
The former `@mariozechner/pi-coding-agent` package stops at 0.73.1 and directs
users to the new namespace. The namespace changed in Pi 0.74.0.

Direct trusted-host profiles pass their explicit provider, model, and reasoning
to the installed launcher and check configured version or digest pins. Current
Pi documents JSON mode, `--provider`, `--model`, `--thinking`, and terminal
`agent_end` followed by `agent_settled` events. Direct profile discovery does not
qualify the guarded enforcement bundle for a new release.

Guarded Pi qualification remains at reviewed version 0.84.4. Its launcher,
enforcement, and containment checks remain required. Preserve these pins until
the replacement bundle passes the applicable contracts. Pi's current `--tools`
selection retains MCP tools unless filtered; read-only argument and extension
controls must be checked when qualifying a new release.

Sources: [current package](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest),
[former package](https://registry.npmjs.org/@mariozechner%2fpi-coding-agent/latest),
[upstream changelog](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md),
[CLI contract](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/cli.md), and
[JSON event contract](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/json.md).

## OMP

OMP's current package is `@oh-my-pi/pi-coding-agent`, version 18.20.2. Ox
Driver's attested qualification remains at 18.0.6 and its documented macOS
arm64 digest and isolation bundle.

OMP 18.20.2 registers ambient discovery providers absent from the qualified
bundle's disabled-provider list, including `claude-md`, `custom-context`,
`skillshare`, and `ssh-config`. Updating the version or binary pin alone does
not preserve isolation. A new qualified release requires an updated discovery
audit, isolation policy, protocol fixtures, and containment checks. OMP writing
and child-agent dispatch remain unavailable.

Sources: [current package](https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest),
[18.20.2 changelog](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/CHANGELOG.md), and
[discovery registry](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/discovery/index.ts).
