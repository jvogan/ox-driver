# Changelog

## 2.0.0-dev.0 - 2026-08-30

### Added

- Run one OpenCode writer in a managed worktree with changed-path and
  acceptance-command receipts.
- Run two-worker pairs or plans containing 2–32 independent OpenCode lanes.
- Retry incomplete lanes in their recorded worktrees without rerunning
  completed lanes.
- Report child output, archive receipt evidence, export lane patches, detect
  overlapping files, and apply selected non-conflicting patches in a separate
  checked worktree.
- Preserve observed OpenCode child-agent lineage, model turns, tool calls,
  tokens, and reported cost when the launcher exposes that evidence.
- Distribute the preview as a deterministic source archive with a SHA-256
  sidecar and file manifest.

### Supported platforms

- macOS and Linux with Node.js 22.20 or later.
- Windows is unsupported in 2.0.0-dev.0.

### Migration

- This release is source-only; no npm package or in-place installer is
  provided.
- Configure an explicit OpenCode launcher, provider, model, and reasoning route
  before dispatch.
- The historical Ox Alpha route, Pi installer, and fleet commands are absent
  from this distribution. See
  [MIGRATION.md](MIGRATION.md).
- Existing 1.x Pi assets and 2.0 controller state may coexist. Version
  2.0.0-dev.0 does not import 1.x receipts or automatically remove 1.x files.

## 1.0.1 - 2026-08-24

- Added a protected 16 MiB aggregate image-history budget for root and child
  provider requests while preserving local transcripts.

## 1.0.0 - 2026-08-23

- Released the original guarded Pi installer and Ox Alpha fleet workflow.
- Added `/solo` and `/team` commands, external-driver guidance, and uninstall
  support for installed Pi assets.

The 1.x Ox Alpha route and fleet surface are retired in 2.0.0-dev.0.
The historical 1.x headings reflect the skill metadata; the public repository's
only pre-2.0 Git tag was `v0.1.0`.
