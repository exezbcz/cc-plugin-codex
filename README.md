# CC Companion

A maintained [Sendbird cc-plugin-codex](https://github.com/sendbird/cc-plugin-codex) derivative that lets Codex delegate reviews and implementation tasks to the installed Claude Code CLI.

Codex manages the task and evaluates the returned work. Claude Code runs locally under its own login and returns streamed results, session IDs and job status.

## What changed

- Host-aware Codex app/CLI instructions, including waiting on an already-running process.
- Explicit subscription authentication checks and read-only `setup --check`.
- Actual tool restrictions for reviews; implementation keeps `bypassPermissions`.
- macOS job identity that survives an executable change.
- Installation/update/uninstall scoped to the selected marketplace.
- Public-source checks and an explicit distribution allowlist.

The implementation plan and acceptance criteria are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Upstream attribution remains in [NOTICE](NOTICE) and [LICENSE](LICENSE).

## Requirements

- Codex with local plugin and hook support.
- Node.js 18+ for the runtime. Development checks use Node.js 24.
- Claude Code installed and signed in through its normal login flow.
- Git for repository reviews.

The bridge does not collect a password, store an OAuth token, or attach to an open Claude terminal. It starts `claude -p` and resumes a recorded Claude conversation only when requested.

## Install this version locally

Clone this source into a directory named `cc`. Ask Codex's built-in **plugin-creator** to register the existing directory in your personal marketplace. The catalog should resolve to this source; do not select Sendbird's catalog when you intend to use this derivative.

Then run from the source directory:

```sh
node scripts/installer-cli.mjs install
```

The installer reads the personal catalog at `~/.agents/plugins/marketplace.json` by default. It installs the selected `cc@<marketplace>` through Codex, enables native hooks and adds only that installation's data root. Open a fresh Codex task and run:

```text
$cc:setup --check
```

This check does not change configuration or call a model. If it reports missing hook trust or setup, `$cc:setup` performs the documented repair. Normal setup can change hook enablement/trust, writable roots and plugin state. The optional automatic review gate starts disabled.

For a different already-registered local catalog, set `CC_PLUGIN_CODEX_MARKETPLACE_PATH` to its `marketplace.json`. For an explicitly chosen remote marketplace, use `CC_PLUGIN_CODEX_MARKETPLACE_SOURCE` and `CC_PLUGIN_CODEX_MARKETPLACE_NAME`; optional `CC_PLUGIN_CODEX_MARKETPLACE_REF` selects a ref. There is no implicit remote marketplace fallback.

## Choose the authentication route

To require Claude subscription authentication for this bridge, make this non-secret setting available to the Codex process or its shell environment:

```sh
export CC_PLUGIN_CODEX_AUTH_MODE=subscription
```

Run `$cc:setup --check` to see the sanitized authentication result. Subscription mode rejects conflicting API keys, alternate providers and ambiguous authentication rather than silently changing billing. Configure the setting in your local environment, not a committed project file.

The default `inherit` mode preserves Claude's existing authentication behavior, including deliberate API/provider setups. It does not guarantee subscription billing. The CLI's account login and refresh remain owned by Claude Code. An explicit environment API key may override a stored subscription login.

Subscription allowances and provider billing rules are controlled by Anthropic. See [its current guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). The bridge cannot certify a future bill from a local readiness probe.

## Use it

| Skill | Purpose |
| --- | --- |
| `$cc:review` | Review current changes without implementing fixes |
| `$cc:adversarial-review` | Challenge design choices and assumptions |
| `$cc:rescue` | Delegate investigation, implementation or a follow-up |
| `$cc:status` | Inspect active/recent jobs |
| `$cc:result` | Retrieve a completed result |
| `$cc:cancel` | Cancel one recorded job |
| `$cc:setup` | Diagnose or repair local integration |

```text
$cc:review --base main
$cc:review --background
$cc:rescue --fresh fix the failing parser test and run focused tests
$cc:rescue --resume add a regression for the edge case
$cc:status
$cc:result <job-id>
$cc:cancel <job-id>
```

Use `--model` and `--effort` for an explicit Claude model/effort choice. These flags select the delegated Claude runtime, not the forwarding Codex agent. Without an override the inherited plugin model default is `opus`; effort is left to Claude. Availability depends on the installed CLI and account.

Implementation/rescue uses `bypassPermissions` in the selected workspace. It can edit files and run commands. Reviews have a separate restricted tool set and deliberate read-only Git MCP access. Codex remains responsible for evaluating proposed work and coordinating concurrent edits.

Background work stays attached to its originating Codex task. If the host does not expose a compatible notification tool, retrieve results with status/result. A long shell call yielding a session handle is continued using that handle; it must not start a second Claude process.

## Update and uninstall

After updating the selected source and following Codex's local cache/version workflow:

```sh
node scripts/installer-cli.mjs update
node scripts/installer-cli.mjs uninstall
```

Uninstall targets one marketplace-qualified identity, preserves saved results and leaves other `cc` installations alone. If the catalog is no longer available, set `CC_PLUGIN_CODEX_MARKETPLACE_NAME` to the exact installation to remove. Source registration and historical data are deliberately retained.

## Privacy and public sharing

Commit only plugin code, generic docs and synthetic tests. Never commit Claude/Codex account directories, credentials, environment files, job logs, prompts/results, session transcripts or personal marketplace/configuration snapshots.

Runtime state is stored in Codex's user-local plugin data area, outside this checkout. It may contain private task context. Do not attach it to public issues. [SECURITY.md](SECURITY.md) describes the boundary and release checks.

```sh
npm ci --ignore-scripts
npm run check
npm audit
npm pack --dry-run --ignore-scripts
```

Development tests use disposable configuration and fake providers; real model smoke tests are separate and consume the selected account's usage. See [maintenance guidance](docs/MAINTAINING.md). This derivative is marked private for npm to prevent accidental package publication; it can still be shared as a reviewed Git repository.
