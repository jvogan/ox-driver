# Changelog

## Unreleased

### Added

- Save repository presets with `init`, preview and run them with `work`, read
  saved results with `result`, and export verified builder patches with `patch`.
- Configure and inspect routes through `ox-driver route`.
- Include a dependency-free first-task example with a failing acceptance test.
- Document current harness package names and qualified release boundaries.
- List configured routes and launcher pins without executing launchers.
- Validate team plans without allocating workers or making model requests.
- Combine latest lane results, attempt history, and cumulative cost evidence
  across a selected retry chain.
- Save integration receipts with selected runs, patch hashes, check results,
  cleanup evidence, and the final workspace digest.

### Fixed

- Reject unsupported OpenCode major versions before optional discovery probes.
- Block an absent selected OpenCode model when a valid catalog is available.
- Resolve acceptance tools through the controller's Node installation before
  inherited version-manager shims while retaining isolated check homes.
- Enforce OpenCode launcher version and digest pins.
- Inspect each harness independently of unrelated route configuration.
- Replace route profiles atomically and preserve symlink targets.
- Preserve existing worktrees and retain records after incomplete rollback.
- Retain recovery holds until process-tree cleanup is verified.
- Reap acceptance and integration descendants on timeout and cancellation.
- Align route and orchestration schemas with runtime admission rules.

## 2.0.0-dev.0

### Added

- Dispatch OpenCode one-writer tasks in managed Git worktrees.
- Record OpenCode direct child route, usage, tool, and reported-cost evidence
  when the installed launcher exposes the required metadata.
- Run pairs and dependency-aware teams containing up to 32 lanes.
- Dispatch Pi writers and read-only reviewers alone or in a Pi-only or mixed
  team.
- Dispatch OMP read-only reviews alone or as dependency-ordered team lanes on
  a qualified attested macOS arm64 route.
- Carry bounded dependency output and receipt evidence into later team stages,
  with terminal-workspace digest binding when ordered lanes reuse a worktree.
- Run OpenCode writer handoffs with Pi or OMP review of the writer's exact
  Git-visible result.
- Resume an interrupted or failed handoff reviewer stage from a durable
  checkpoint.
- Retry incomplete orchestration lanes in their recorded worktrees.
- Inspect and archive receipts, export patches, detect overlapping changes,
  and apply selected non-conflicting work in a checked integration worktree.
- Inspect installed ACP and DeepSeek Harness adapters without model requests.
  Both adapters reject task dispatch.

### Boundaries

- Trusted-host OpenCode and Pi use the access available to their installed
  launcher processes.
- Managed worktrees separate Git changes and provide no OS sandbox.
- Trusted-host cost targets report observed cost after execution.
- OMP dispatch claims only the qualified read-only macOS arm64 route.
- Ox-managed Pi child-profile selection, OMP writing, OMP children, ACP
  dispatch, and DeepSeek Harness dispatch remain unavailable through Ox Driver.

### Distribution

- Provide a deterministic source archive with a SHA-256 sidecar and file
  manifest.
- Validate the extracted source tree, capability contract, skill, and
  machine-neutral documentation before publication.
