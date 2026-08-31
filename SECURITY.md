# Security

Report vulnerabilities through the repository's GitHub Security Advisories
page. Select **Report a vulnerability** and include the smallest non-sensitive
reproduction that demonstrates the affected boundary.

Do not put exploit details, authentication values, prompts, transcripts,
repository content, or identifying filesystem paths in a GitHub issue. If the
report form is unavailable, open an issue that requests a secure reporting
channel and omit vulnerability details.

Include these facts when available:

- Ox Driver version or commit;
- operating system;
- harness and harness version;
- selected trust tier;
- expected boundary;
- observed result;
- receipt fields required to reproduce the failure after redaction.

## Trusted-host boundary

OpenCode and direct Pi runs use the filesystem, process, and network access
available to their installed launcher processes. A managed Git worktree
separates changes from the source checkout and provides no OS sandbox.

`--owned` and `--exclude` classify Git-visible changes after execution. They do
not prevent reads or writes. Inspect writer diffs and receipts before
integration.

Trusted-host cost targets evaluate reported cost after execution. Configure a
provider-side or launcher-side limit when a run requires a hard spending cap.

## Attested boundary

OMP dispatch claims only a qualified read-only macOS arm64 route. Its
route checks bind the launcher, runtime configuration, tool inventory, and
process-containment mechanism. Writing, child agents, other operating systems,
and other containment-mechanism digests remain unavailable.

## Inspection-only adapters

ACP and DeepSeek Harness doctors make no model request. Their adapters expose
inspection evidence and reject task dispatch during preflight and execution.

## Stored data

Ox Driver state can contain objectives, absolute paths, terminal output,
events, receipts, check output, patches, worktree metadata, and configured
route identity. Select state roots and retention periods that match the target
repository's data policy.

Keep authentication values out of route profiles, task text, prompts,
receipts, repositories, documentation, and vulnerability reports.
