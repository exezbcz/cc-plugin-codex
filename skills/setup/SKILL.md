---
name: setup
description: 'Check whether Claude Code CLI is ready in this environment and optionally toggle the turn-end review gate. Args: --check, --enable-review-gate, --disable-review-gate. Use for installation, authentication, or review-gate setup requests.'
---

<!-- Modified to distinguish diagnostics from authorized setup changes. -->

# Claude Code Setup

Use this skill when the user wants to verify Claude Code readiness or toggle the review gate.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root.

Supported arguments:
- `--check` (read-only diagnostics; cannot combine with review-gate toggles)
- `--enable-review-gate`
- `--disable-review-gate`

Workflow:
- For a readiness or authentication check, use `setup --check --json` to inspect readiness without changing Codex configuration, hook trust, or plugin state. Return `setup --check` for the human-readable report. Stop after diagnostics unless setup changes were requested or already authorized.
- Normal `setup` is a mutating repair operation: it can enable hooks, trust this plugin's hook hashes, and update writable roots. Run it when setup or repair is requested or already authorized; preserve that authorization without adding another confirmation.
- `--check` cannot be combined with `--enable-review-gate` or `--disable-review-gate`.
- For an authorized setup or review-gate change, first run the machine-readable command:
  `node "<plugin-root>/scripts/claude-companion.mjs" setup --json $ARGUMENTS`
- If it reports that Claude Code is unavailable and `npm` is available, install only when installation is requested or already authorized; otherwise explain the missing prerequisite.
- For an authorized installation, run `npm install -g @anthropic-ai/claude-code` and rerun setup.
- If Claude Code is already installed or `npm` is unavailable, do not ask about installation.
- If setup reports missing native plugin hook features or hook trust, rerun setup once. The companion repairs `[features].hooks` and this plugin's native hook trust hashes itself.
- If setup adds the plugin-data destination to the writable-root list, do not retry in the same Codex session. Tell the user to restart Codex and rerun the same setup command; any requested review-gate change is deliberately deferred until that restart.
- After the decision flow is complete, run the final user-facing command without `--json`:
  `node "<plugin-root>/scripts/claude-companion.mjs" setup $ARGUMENTS`

Output:
- Present the final non-JSON setup output exactly as returned by the companion.
- Use the JSON form only for branching logic such as install or auth decisions.
- Preserve any authentication guidance if setup reports that login is still required.
- `CC_PLUGIN_CODEX_AUTH_MODE=subscription` explicitly selects existing Claude subscription authentication; the default `inherit` follows the CLI environment. Let Claude Code own login and credentials.
