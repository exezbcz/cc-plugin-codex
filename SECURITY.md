# Security and data handling

## Source and runtime data

This repository contains plugin code, generic documentation and synthetic tests. It must not contain Claude or Codex account files, tokens, passwords, private keys, personal configuration, marketplace snapshots, job outputs, prompts, session transcripts or local test logs.

Claude Code owns sign-in and credential refresh. The bridge invokes the installed CLI. Authentication checks consume the CLI's status output and expose only permitted status fields; they do not extract a token from Keychain or credential files.

Runtime jobs and results live under Codex's user-local plugin data directory, outside the source checkout. These files can contain sensitive task context. They are not release artifacts and must not be uploaded to public issues. Environment/authentication settings belong in local configuration and never in a committed environment file.

## Execution permissions

Implementation tasks deliberately use `bypassPermissions` in the chosen workspace. A read-only review uses a distinct builtin tool restriction, deliberate read-only Git MCP connection and disabled personal/project startup hooks. Managed organizational policy can override CLI settings. These controls are not a new OS sandbox and should not be described as confinement of every possible capability.

Codex remains responsible for selecting an appropriate task/workspace and evaluating changes. Subscription authentication mode rejects conflicting or unverified routes before a model invocation; it cannot certify future billing or override provider limits.

## Before publishing

1. Run `npm run check:public` to inspect source, index and package candidates for private artifacts and recognizable secret formats. The scanner reports rule/file/line, never the matched value.
2. Run `gitleaks git . --log-opts='--all' --redact=100 --no-banner` to scan Git history, and scan the final source/archive with Gitleaks too.
3. Inspect `npm pack --dry-run --ignore-scripts` and the actual archive. Keep the explicit package.files allowlist; do not ship a whole working directory.
4. Review new images, fixtures, documentation and Git commit metadata for personal information. Automated text scans do not inspect image pixels or guarantee detection of every secret format.
5. Run `npm audit` and the test suite. Do not upload raw diagnostic transcripts as CI artifacts.

Ignore rules are a convenience, not a security boundary: files previously tracked remain in history, and forced Git additions can bypass ignores. If an actual credential ever enters history, revoke it first, then remove it from all published history and artifacts.

## Reporting

Use a private vulnerability report to this repository's maintainers when available. Reports should contain a minimal synthetic reproduction, affected version and behavior. Do not include credentials, complete configuration files, private source, account details or unredacted runtime logs. Upstream Sendbird issues should be reported upstream only when reproduced there and authorized by the reporter.
