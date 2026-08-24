# Security

Do not open a public issue for a suspected vulnerability that could expose
credentials or private data. Use GitHub's **Security** tab to report a private
vulnerability advisory to the maintainers.

Include the affected version, operating system, Pi and package versions, the
smallest non-sensitive reproduction, and the expected boundary. Remove tokens,
paths, prompts, transcripts, and repository content that could identify a user
or disclose private data.

Ox Driver is defense in depth around an AI coding agent. Route, sensitive-path,
network, child-argument, agent-scope, and conservative tool-ceiling checks are
mechanical. Natural-language task assignment and best-effort shell-command
matching are not OS containment. Use `edit-only` or `review-only`, restricted
networking, and a non-sensitive checkout when stronger limits are required.
