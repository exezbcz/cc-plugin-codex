<!-- Modified for Codex app and CLI host compatibility. -->

# Claude Code Rescue Runtime Reference

Use this document inside the rescue forwarding worker spawned by `$cc:rescue`, or in the parent when the host has no built-in agent, as defined in `../../skills/rescue/SKILL.md`.
This is an internal execution contract, not a public skill. It owns execution and routing. It does not own prompt rewriting beyond deciding when to consult the prompt-shaping reference.
The public rescue skill already resolved the active plugin root from its `SKILL.md` path. Reuse that path here. Do not derive a new runtime path from this document or the current working tree.

Before executing, read the [shared host execution contract](../host-runtime/runtime.md). It defines schema-aware agent routing, waiting on a yielded process, execution permissions, and completion delivery for the Codex app and CLI. If no built-in agent is available, run the companion in the parent in the foreground as described there.

Primary helper:
- `node "<plugin-root>/scripts/claude-companion.mjs" task ...`

Execution rules:
- The rescue subagent is a forwarder, not an operator. Launch exactly one `task` command and return that stdout unchanged.
- Prefer the helper over hand-rolled Bash, direct Claude Code CLI strings, or any other orchestration path.
- Never call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from the rescue forwarder.
- The parent owns prompt shaping through `../task-prompt-shaping/prompt-shaping.md`. Preserve its resolved command; the worker must not rewrite the task, inspect the repo, solve the task itself, or add independent analysis.

Command selection:
- Treat `--background` and `--wait` as execution controls.
- `--background` and `--wait` are parent-side execution controls only. They describe whether the main Codex thread waits for this subagent.
- Strip both before building the `task` command.
- Never call `task --background` or invent `task --wait`.
- The companion task command always runs in the foreground.
- The caller's background or foreground choice changes only subagent execution. It does not change the companion command you build.

Routing controls:
- Treat `--model`, `--effort`, `--resume`, `--resume-last`, `--fresh`, `--prompt-file`, `--view-state`, `--owner-session-id`, and `--job-id` as routing controls, not task text.
- Leave `--model` and `--effort` unset unless the user explicitly asks for a specific model or effort. The companion command defaults model to `claude-fable-5-1` and forwards no `--effort` at all, so `fable`, `opus`, `sonnet`, and `haiku` each keep whatever effort Claude Code defaults to for them. Claude Code owns which effort levels each model supports; this plugin owns no per-model effort table.
- Forward an explicit `--model` value unchanged to the companion. The companion trims surrounding whitespace, canonicalizes the friendly aliases `fable`, `opus`, `sonnet`, and `haiku` to lowercase, then forwards every other `--model` value unchanged to Claude Code. Claude Code owns alias resolution; `/model` is the authoritative picker for the current account and provider.
- `--view-state on-success` means the user will see this companion result in the current turn, so the companion may mark it viewed on success.
- `--view-state defer` means the parent is not waiting, so the companion must leave the result unread until the user explicitly checks it.
- `--owner-session-id <session-id>` is an internal parent-session routing control. Preserve it when present so tracked jobs remain visible to the parent session's `$cc:status` / `$cc:result`.
- Whenever the command includes a reserved `--job-id`, also include `--cwd <workspace-root>` using `workspaceRoot` from the same routing-context response. Reserved job ids are workspace-scoped.
- Never emit an empty routing placeholder such as `--owner-session-id  --job-id`.
- Do not add `--quiet-progress` by default for built-in rescue forwarding. Let companion stderr progress remain available in the spawned agent thread.
- If the free-text task begins with `/`, treat that slash command as literal Claude Code task text to forward unchanged. Do not execute it as a local Codex slash command or answer it inline.
- If the forwarded request includes `--resume` or `--resume-last`, continue the latest tracked Claude Code task.
- If the forwarded request includes `--fresh`, start a new task.
- If none of `--resume`, `--resume-last`, or `--fresh` is present, do not explore resumable sessions yourself. The parent rescue skill already owns that choice.
- If the parent supplied no explicit continuation flag, preserve that choice and let the companion apply its defaults.
- Never call `task-resume-candidate` from the rescue forwarder.

Task defaults:
- Default to `--write` unless the user explicitly wants read-only behavior or only review, diagnosis, or research without edits.
- Preserve the user's task text apart from stripping routing flags.
- If the resolved task text is multi-line, contains shell-hostile quoting, or includes XML-style blocks, prefer staging it in a temporary prompt file and pass it through `--prompt-file` instead of inlining it in one shell string.
- When staging a prompt file, keep the exact task text byte-for-byte and prefer a temporary path outside the repository checkout so the rescue flow does not dirty the repo.
- Use a structured file-write path to create that prompt file when possible. Do not solve shell quoting by wrapping the same long task inside another brittle inline shell command.
- If the tool output includes stderr progress chatter and a final stdout-style result, ignore the progress chatter and preserve only the final stdout-equivalent result text.
- Return the stdout of the `task` command exactly as-is.
- Use steering messages that point the parent at `$cc:result` or `$cc:status` instead of embedding the raw Claude result.
- For background rescue, use that same steering message as the child's own final assistant message instead of echoing the raw companion result.
- Do not poll status, fetch results, cancel jobs, or add commentary after the companion output.
- If the companion reports missing setup or authentication, return its output unchanged; the parent can direct the user to `$cc:setup`.
