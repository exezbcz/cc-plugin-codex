<!-- Modified for Codex app and CLI host compatibility. -->

# Claude Code Review Runtime Reference

Use this document only when the main Codex thread or a built-in forwarding child is executing a Claude Code `review` or `adversarial-review` command.
This is an internal runtime reference, not a public skill. It captures the exact companion-command contract and the foreground/background execution boundary.
The public skill already resolved the active plugin root from its `SKILL.md` path. Reuse that path here. Do not derive a new runtime path from this document or the current working tree.

Before executing, read the [shared host execution contract](../host-runtime/runtime.md). It defines schema-aware agent routing, waiting on a yielded process, execution permissions, and completion delivery for the Codex app and CLI. If no built-in agent is available, run the companion in the parent in the foreground as described there.

Primary helper:
- `node "<plugin-root>/scripts/claude-companion.mjs" review ...`
- `node "<plugin-root>/scripts/claude-companion.mjs" adversarial-review ...`

Execution boundary:
- Foreground review stays on the main Codex thread. Do not satisfy foreground review through a review subagent, a generic review-runner role, or any background worker abstraction.
- Background review uses exactly one built-in forwarding child through `spawn_agent`.
- Never satisfy either mode with raw `claude`, `claude-code`, `claude review`, hand-rolled `bash -lc ...claude...`, or detached companion shell backgrounding.
- If the resolved companion command fails, surface that failure instead of improvising a different executor.

Foreground contract:
- Strip `--wait` and `--background` before building the companion command.
- Foreground command:
  - `review --view-state on-success ...`
  - `adversarial-review --view-state on-success ...`
- Return companion stdout faithfully and do not add review execution commentary around it.

Background contract:
- Use `background-routing-context --kind review --json` before spawning the forwarding child.
- Preserve `--job-id` only when reserved by the parent helper.
- Whenever preserving that reserved `--job-id`, also pass `--cwd <workspace-root>` using `workspaceRoot` from the same helper response. Reserved job ids are workspace-scoped.
- Preserve `--owner-session-id` only when the parent helper returned a non-empty owner session id.
- Preserve the parent notification path only when the helper returned a non-empty parent thread id.
- Never emit an empty routing placeholder such as `--owner-session-id  --job-id`.
- The built-in child runs exactly one shell command:
  - `review --view-state defer ...`
  - `adversarial-review --view-state defer ...`
- The child must be a pure forwarder:
  - return stdout only
  - ignore stderr progress chatter such as `[cc] ...`
  - do not inspect the repo or perform the review itself

Spawn-agent defaults follow the shared host execution contract.

Completion steering:
- When a reserved review job id exists, steer to:
  - `Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.`
  - `Background Claude Code adversarial review finished. Open it with $cc:result <reserved-job-id>.`
- Otherwise steer to `$cc:status` first, then `$cc:result`.
- Use that same steering message as the child's own final assistant message for background mode.
- Never inline raw review text in the notification or in the child's final assistant message for background mode.
