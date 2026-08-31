# Changelog

## 2.0.0-dev.0

### Added

- Dispatch OpenCode one-writer tasks in managed Git worktrees.
- Record OpenCode direct child route, usage, tool, and reported-cost evidence
  when the installed launcher exposes the required metadata.
- Run two-worker pairs and herds containing up to 32 independent lanes.
- Dispatch Pi solo writers and solo read-only reviewers through explicit route
  profiles.
- Add Pi as an independent herd review lane.
- Dispatch OMP solo read-only reviews through the qualified attested macOS
  arm64 route.
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
- Pi children and teams, OMP writing, OMP children, ACP dispatch, and DeepSeek
  Harness dispatch remain unavailable through Ox Driver.

### Distribution

- Provide a deterministic source archive with a SHA-256 sidecar and file
  manifest.
- Validate the extracted source tree, capability contract, skill, and
  machine-neutral documentation before publication.
