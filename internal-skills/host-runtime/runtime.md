# Codex Host Execution Contract

Use this contract for foreground companion commands and forwarding workers in the Codex app or CLI. The host's exposed tool schemas and execution policy are authoritative; this reference grants no additional permissions.

## Agent routing

- Use one built-in forwarding agent when `spawn_agent` is available and delegation is permitted. Pass a self-contained message, the resolved command, and the applicable runtime contract.
- Read the actual `spawn_agent` schema. If it exposes `fork_turns`, use `fork_turns: "none"`; otherwise, if it exposes `fork_context`, use `fork_context: false`. Never send both fields or invent an unsupported field. Supply required fields such as `task_name` only when that schema requires them.
- Omit `agent_type`, `model`, and `reasoning_effort` by default so the worker inherits the host's defaults. Apply a user-requested Codex worker override only when the exposed tool supports that parameter and value. The companion's `--model` and `--effort` still select Claude Code, independently of the forwarding agent.
- If no built-in agent is available or delegation is disabled, run the same companion command in the parent in the foreground. Explain this fallback briefly; use `--view-state on-success` and return its stdout. Do not create a separate user-owned task or detach a shell process to imitate background support.

## One process through completion

- Start exactly one companion process in non-interactive foreground mode. Do not use `&`, `nohup`, detached spawning, or a second command launch to continue a running job.
- Use the host's permitted execution defaults. Do not assume the sandbox is network-disabled, and do not unconditionally request escalation. When `sandbox_permissions` is absent from the schema or forbidden by policy, omit it. If the host requires a permission flow for a concrete failure, follow that host flow; never change policy to bypass it.
- A tool response with a running process/session/cell identifier is a yield, not completion. Continue waiting on that same process using the exposed continuation tool and the returned identifier (for example `write_stdin` after `exec_command`, or `wait` after a yielded `functions.exec` cell). Never relaunch the command after a yield. If a resumed cell returns a shell session identifier, continue that shell session through its own continuation tool.
- Wait until the process exits before returning success. Accumulate stdout across all chunks in order, excluding stderr progress; preserve the final stdout exactly. Surface an execution failure instead of launching a different Claude invocation. If output was truncated, report that to the parent so it can retrieve the stored job result; do not guess or relaunch the task.
- Preserve the parent's reserved `--job-id`, matching `--cwd`, non-empty `--owner-session-id`, and foreground/background `--view-state`. Waiting for a yielded process does not change job ownership or mark a deferred result viewed.

## Completion delivery

- The worker's final message is the normal completion channel. Foreground workers return stdout; background workers return the short steering message linking to `$cc:result <job-id>` (or `$cc:status` when no job id is known).
- Use at most one additional success notification only if the host exposes a supported messaging tool whose documented target type accepts this parent. Native automatic completion delivery normally makes an extra notification unnecessary.
- Read that tool's schema; never require a tool named `send_input`, invent arguments, or treat a persistent task ID as a collaboration-agent ID. Parent IDs and collaboration-agent addresses belong to different tool APIs.
- If no compatible notification tool exists, use the worker's final message and stored status/result. Do not claim that the parent will be woken or promise proactive notification unless the host provides it. Never embed raw Claude output in background steering messages.
