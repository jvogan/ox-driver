# Security

Do not put vulnerability details, credentials, or private data in a public
issue. Use GitHub's private vulnerability report form when the repository
Security tab provides it. If that form is unavailable, open a public issue
containing only a request for private security contact; wait for a private
channel before sharing the report.

Include the affected version, operating system, harness and package versions, the
smallest non-sensitive reproduction, and the expected boundary. Remove tokens,
paths, prompts, transcripts, and repository content that could identify a user
or disclose private data.

The public OpenCode preview is a trusted-host controller. OpenCode receives the
filesystem and network access of the installed launcher process. A managed
worktree separates Git changes; the launcher retains access to other host paths
and credentials. Run Ox Driver only where the worker may use the available
files, credentials, and network access.

`--owned` and `--exclude` classify Git-visible changes after execution. They do
not prevent reads or writes. Reported cost is evaluated after execution and
cannot stop provider billing. Configure provider-side or launcher-side limits
when a run requires a hard spending cap.
