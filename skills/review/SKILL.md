---
name: review
description: 'Run a standard Claude Code review of local git changes in this repository. Args: --wait, --background, --base ref, --scope auto|working-tree|branch, --model model, --effort low|medium|high|xhigh|max. Defaults to Claude Fable 5.1 (claude-fable-5-1) with no forced effort. Use as the default path for ordinary code-review requests when the user did not explicitly ask for stronger adversarial scrutiny or for Claude to own the implementation work.'
---

<!-- Modified for Codex app and CLI host compatibility. -->

# Claude Code Review

Use this skill when the user wants Claude Code to review the current working tree or a branch diff in this repository.

Use `$cc:review` as the default when the user asks for code review, asks you to have Claude review something, or wants a second review pass without explicitly asking for stronger adversarial scrutiny.
If the user asks for stronger challenge on design, tradeoffs, rollout risk, migration risk, configuration behavior, or provides custom review focus text, route to `$cc:adversarial-review` instead.
If the user wants Claude Code to investigate, validate by changing code, or actually fix/implement something, route to `$cc:rescue` instead.
If the overall request is "you review it too, also ask Claude to review in the background, then you aggregate and fix it", keep the delegated Claude part on `$cc:review` unless the user explicitly asks for a harsher or more adversarial review.
`$cc:review` does not accept custom focus text. If the user wants to steer Claude toward a particular angle, question, subsystem, or risk area, that is a signal to use `$cc:adversarial-review` instead.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:
`node "<plugin-root>/scripts/claude-companion.mjs" review ...`

Supported arguments: `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`, `--model <model>`, `--effort <low|medium|high|xhigh|max>` (defaults: model=claude-fable-5-1 and no effort; `fable`, `opus`, `sonnet`, and `haiku` each keep Claude Code's own effort default, and Claude Code owns which effort levels each model supports)

Forward `--model` unchanged to the companion. The companion trims surrounding whitespace, canonicalizes the friendly aliases `fable`, `opus`, `sonnet`, and `haiku` to lowercase, then forwards every other `--model` value unchanged to Claude Code. Claude Code owns alias resolution and supported effort levels; `/model` is the authoritative picker for the current account and provider.

Before executing, read the [shared host execution contract](../../internal-skills/host-runtime/runtime.md). It defines schema-aware agent routing, waiting on a yielded process, execution permissions, and completion delivery for the Codex app and CLI. If no built-in agent is available, run the companion in the parent in the foreground as described there.

Raw slash-command arguments:
`$ARGUMENTS`

Rules:
- This skill is review-only. Do not fix issues, apply patches, or suggest that you are about to make changes.
- Before launching the review, stay in read-only inspection mode: inspect git status and diff stats only, then ask at most one user question about whether to wait or run in background.
- Preserve the user's review scope flags exactly.
- Do not accept staged-only or unstaged-only review modes.
- Do not add extra review instructions or focus text. Route those requests to `$cc:adversarial-review`.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in background through the built-in review subagent path.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Use the recommended execution mode unless the user's choice is already explicit. An optional preference question may use `request_user_input` only when this thread actually has one and its current mode permits the call. If that tool is absent or unavailable in the current mode, proceed with the recommended mode; do not invent a picker or stop merely to choose foreground versus background.


Argument handling:
- Preserve the user's arguments exactly.
- Treat `--wait` and `--background` as Codex-side execution controls only. Strip them before calling the companion command.
- `$cc:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `$cc:adversarial-review`.
- The companion review process itself always runs in the foreground. Background mode only changes how Codex launches that command.
- For the detailed execution contract, treat the internal runtime reference at `../../internal-skills/review-runtime/runtime.md` as supporting guidance only. It is an internal reference document, not a public skill to invoke.

Foreground flow:
- Run:
  `node "<plugin-root>/scripts/claude-companion.mjs" review --view-state on-success <arguments with --wait/--background removed>`
- Foreground review belongs to the main Codex thread. Do not spawn a review subagent, do not invoke a generic review-runner role, and do not proxy this foreground path through any background worker abstraction.
- Do not fall back to raw `claude`, `claude-code`, `claude review`, `bash -lc ...claude...`, or any other direct Claude CLI syntax when the companion path is available. The foreground syntax contract here is the resolved companion command above, not a hand-rolled Claude invocation.
- If the resolved companion command fails, surface that failure. Do not silently retry foreground review through a different CLI shape, a generic review runner, or a custom shell wrapper.
- Present the companion stdout faithfully.
- Do not fix anything mentioned in the review output.

Background flow:
- For background review, use Codex's built-in `default` subagent instead of a detached background shell command.
- Do not satisfy background review by using a generic `claude_review_runner`-style helper role, raw Claude CLI, or any other review executor that bypasses the resolved companion command.
- Never satisfy background review by running the companion command itself with shell backgrounding such as `&`, `nohup`, detached `spawn`, or any equivalent direct background process launch.
- Background here means "spawn the forwarding child via `spawn_agent` and do not wait in the parent turn." The companion review command inside that child still runs once, in the foreground, inside the child thread.
- Before spawning the built-in child, capture the review job id plus routing context in one call:
  `node "<plugin-root>/scripts/claude-companion.mjs" background-routing-context --kind review --json`
- If that helper returns a non-empty `jobId`, pass it into the companion command as an internal `--job-id <reserved-job-id>` routing flag.
- Whenever forwarding that reserved `--job-id`, also pass `--cwd <workspace-root>` using `workspaceRoot` from the same helper response. Reserved job ids are workspace-scoped.
- If that helper returns a non-empty `ownerSessionId`, include `--owner-session-id <owner-session-id>` in the companion command.
- If it returns an empty `ownerSessionId`, omit `--owner-session-id` entirely. Never leave an empty placeholder such as `--owner-session-id  --job-id`.
- If that helper returns a non-empty `parentThreadId`, pass it into the child prompt as the parent thread id for one-shot completion notification.
- If it returns an empty `parentThreadId`, omit the notification path instead of emitting a blank thread-id placeholder.
- Spawn exactly one transient forwarding child through the available `spawn_agent` tool, using the host execution contract. The child inherits the parent model and host defaults unless the user requests a supported Codex worker override.
- Prefer a self-contained child message over inheriting parent history. The built-in review child should not rely on full parent thread replay for normal operation.
- Follow the host execution contract for agent creation, process yields, permissions, and completion delivery. Include its applicable rules in the child message.
- The built-in child must be a pure forwarder. It should:
  - run exactly one shell command
  - execute:
    `node "<plugin-root>/scripts/claude-companion.mjs" review --view-state defer <arguments with --wait/--background removed>`
  - include `--owner-session-id <owner-session-id>` only when the parent resolved a non-empty owner session id
  - include `--job-id <reserved-job-id>` when the parent reserved one
  - include the matching `--cwd <workspace-root>` whenever the command includes that reserved `--job-id`
  - never leave an empty routing placeholder such as `--owner-session-id  --job-id`
  - return only that command's stdout exactly, with no added commentary
  - ignore stderr progress chatter such as `[cc] ...` lines and preserve only the final stdout-equivalent result text
  - not inspect the repo or perform the review itself
  - if a reserved review job id is available, use this exact notification message:
    `Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.`
  - otherwise fall back to:
    `Background Claude Code review finished. Inspect it with $cc:status first, then use $cc:result for the finished job you want to open.`
  - use these steering messages instead of embedding the raw review result in the notification
  - do not embed the raw Claude result inside the notification message
  - do not include any other prose in that notification message
  - use that same steering message as the child's own final assistant message instead of echoing the raw review result
- Do not wait for completion in this turn.
- After launching, tell the user: `Claude Code review started in the background. Check the subagent session or $cc:status for progress, then open the completed job with $cc:result.`
- Do not fix anything mentioned in the review output.
