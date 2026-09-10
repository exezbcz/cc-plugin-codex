/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Modified to check portable host execution contracts.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
}

test("public model contracts document native Fable support and host-owned effort defaults", () => {
  const contracts = [
    "skills/review/SKILL.md",
    "skills/adversarial-review/SKILL.md",
    "skills/rescue/SKILL.md",
    "internal-skills/cli-runtime/runtime.md",
  ];

  for (const contractPath of contracts) {
    const contract = read(contractPath);
    assert.match(contract, /fable/i, `${contractPath} must document Fable`);
    // Assert only what the plugin controls: no per-model effort default of its
    // own, and effort support attributed to Claude Code. Do not pin a claim
    // about how the CLI handles a specific model + effort pair; that is the
    // host's behavior and this plugin never observes it.
    assert.match(
      contract,
      /Claude Code (owns|defaults)[^\n]*effort|effort[^\n]*Claude Code/i,
      `${contractPath} must attribute effort defaults to Claude Code`
    );
    assert.doesNotMatch(
      contract,
      /default(s)? to `?high`? effort/i,
      `${contractPath} must not claim a plugin-owned per-model effort default`
    );
  }
});

test("model contracts delegate discovery and alias resolution to Claude Code", () => {
  const contracts = [
    "skills/review/SKILL.md",
    "skills/adversarial-review/SKILL.md",
    "skills/rescue/SKILL.md",
    "internal-skills/cli-runtime/runtime.md",
  ];

  for (const contractPath of contracts) {
    const contract = read(contractPath);
    assert.match(contract, /\/model/i, `${contractPath} must point to Claude Code model discovery`);
    assert.match(
      contract,
      /friendly aliases?[^\n]*lowercase/i,
      `${contractPath} must document friendly alias canonicalization`
    );
    assert.match(
      contract,
      /every other `--model` value[^\n]*unchanged/i,
      `${contractPath} must preserve non-friendly model values`
    );
  }

  for (const contractPath of contracts) {
    const contract = read(contractPath);
    assert.match(
      contract,
      /Forward (?:an explicit )?`--model`(?: value)? unchanged to the companion/i,
      `${contractPath} must preserve the user's model value until the companion boundary`
    );
  }

  const implementation = [
    read("scripts/claude-companion.mjs"),
    read("scripts/lib/claude-cli.mjs"),
  ].join("\n");
  assert.doesNotMatch(implementation, /MODEL_ALIASES/);
  assert.doesNotMatch(implementation, /claude-(?:opus|sonnet|haiku)-\d/);
  assert.doesNotMatch(implementation, /\[1m\]/);
});

test("built-in child commands preserve the workspace for reserved job ids", () => {
  const skills = [
    ["rescue", "skills/rescue/SKILL.md"],
    ["review", "skills/review/SKILL.md"],
    ["adversarial review", "skills/adversarial-review/SKILL.md"],
  ];

  for (const [name, skillPath] of skills) {
    const skill = read(skillPath);
    assert.match(
      skill,
      /Whenever forwarding that reserved `--job-id`, also pass `--cwd <workspace-root>` using `workspaceRoot` from the same helper response/i,
      `${name} must keep reserved job ids in their workspace`,
    );
    assert.match(
      skill,
      /include the matching `--cwd <workspace-root>` whenever the (?:exact )?command (?:contains|includes) (?:that )?reserved `--job-id/i,
      `${name} child command must forward the reserved job workspace`,
    );
  }
});

test("internal runtime references keep the active-root and notification invariants", () => {
  const reviewRuntime = read("internal-skills/review-runtime/runtime.md");
  const rescueRuntime = read("internal-skills/cli-runtime/runtime.md");
  const activeRootPattern = /<plugin-root>\/scripts\/claude-companion\.mjs/i;

  assert.match(reviewRuntime, /resolved the active plugin root/i);
  assert.match(reviewRuntime, activeRootPattern);
  assert.match(reviewRuntime, /Do not derive a new runtime path from this document or the current working tree/i);
  assert.match(reviewRuntime, /Never emit an empty routing placeholder such as `--owner-session-id {2}--job-id`/i);
  assert.match(reviewRuntime, /Use that same steering message as the child's own final assistant message for background mode/i);

  assert.match(rescueRuntime, /resolved the active plugin root/i);
  assert.match(rescueRuntime, activeRootPattern);
  assert.match(rescueRuntime, /Do not derive a new runtime path from this document or the current working tree/i);
  assert.match(rescueRuntime, /Never emit an empty routing placeholder such as `--owner-session-id {2}--job-id`/i);
  assert.match(rescueRuntime, /Do not add `--quiet-progress` by default/i);
  assert.match(rescueRuntime, /slash command as literal Claude Code task text/i);
  assert.match(rescueRuntime, /Use steering messages that point the parent at `\$cc:result` or `\$cc:status` instead of embedding the raw Claude result/i);
  assert.match(rescueRuntime, /use that same steering message as the child's own final assistant message instead of echoing the raw companion result/i);
});

test("review skills keep background execution outside the companion command", () => {
  const review = read("skills/review/SKILL.md");
  const adversarial = read("skills/adversarial-review/SKILL.md");
  const activeRootPattern = /<plugin-root>\/scripts\/claude-companion\.mjs/i;

  assert.match(review, /Resolve `<plugin-root>` as two directories above this `SKILL\.md` file/i);
  assert.match(review, /Use `\$cc:review` as the default when the user asks for code review, asks you to have Claude review something, or wants a second review pass without explicitly asking for stronger adversarial scrutiny/i);
  assert.match(review, /If the user asks for stronger challenge on design, tradeoffs, rollout risk, migration risk, configuration behavior, or provides custom review focus text, route to `\$cc:adversarial-review` instead/i);
  assert.match(review, /If the user wants Claude Code to investigate, validate by changing code, or actually fix\/implement something, route to `\$cc:rescue` instead/i);
  assert.match(review, /If the overall request is "you review it too, also ask Claude to review in the background, then you aggregate and fix it", keep the delegated Claude part on `\$cc:review` unless the user explicitly asks for a harsher or more adversarial review/i);
  assert.match(review, /`\$cc:review` does not accept custom focus text/i);
  assert.match(review, activeRootPattern);
  assert.match(review, /Treat `--wait` and `--background` as Codex-side execution controls only/i);
  assert.match(review, /Strip them before calling the companion command/i);
  assert.match(review, /The companion review process itself always runs in the foreground/i);
  assert.match(review, /internal runtime reference at `\.\.\/\.\.\/internal-skills\/review-runtime\/runtime\.md`/i);
  assert.match(review, /It is an internal reference document, not a public skill to invoke/i);
  assert.match(review, /review --view-state on-success/i);
  assert.match(review, /Foreground review belongs to the main Codex thread/i);
  assert.match(review, /Do not spawn a review subagent/i);
  assert.match(review, /do not invoke a generic review-runner role/i);
  assert.match(review, /Do not fall back to raw `claude`, `claude-code`, `claude review`, `bash -lc \.\.\.claude\.\.\.`/i);
  assert.match(review, /If the .*companion command fails, surface that failure/i);
  assert.match(review, /For background review, use Codex's built-in `default` subagent/i);
  assert.match(review, /Do not satisfy background review by using a generic `claude_review_runner`-style helper role/i);
  assert.match(review, /Never satisfy background review by running the companion command itself with shell backgrounding/i);
  assert.match(review, /Background here means "spawn the forwarding child via `spawn_agent` and do not wait in the parent turn\."/i);
  assert.match(review, /background-routing-context --kind review --json/i);
  assert.match(review, /internal `--job-id <reserved-job-id>` routing flag/i);
  assert.match(review, /non-empty `ownerSessionId`/i);
  assert.match(review, /omit `--owner-session-id` entirely/i);
  assert.match(review, /spawn_agent/i);
  assert.doesNotMatch(review, /gpt-5/i);
  assert.match(review, /Prefer a self-contained child message over inheriting parent history/i);
  assert.match(review, /review --view-state defer/i);
  assert.match(review, /include `--owner-session-id <owner-session-id>` only when the parent resolved a non-empty owner session id/i);
  assert.match(review, /never leave an empty routing placeholder such as `--owner-session-id {2}--job-id`/i);
  assert.match(review, /Background Claude Code review finished\. Open it with \$cc:result <reserved-job-id>\./i);
  assert.match(review, /use these steering messages instead of embedding the raw review result in the notification/i);
  assert.match(review, /do not embed the raw Claude result inside the notification message/i);
  assert.match(review, /do not include any other prose in that notification message/i);
  assert.match(review, /use that same steering message as the child's own final assistant message instead of echoing the raw review result/i);
  assert.match(review, /Check the subagent session or \$cc:status for progress, then open the completed job with \$cc:result\./i);
  assert.doesNotMatch(review, /claude-companion\.mjs" review --background/i);
  assert.doesNotMatch(review, /claude-companion\.mjs" review \$ARGUMENTS/i);

  assert.match(adversarial, /Resolve `<plugin-root>` as two directories above this `SKILL\.md` file/i);
  assert.match(adversarial, /Do not treat `\$cc:adversarial-review` as the default review path/i);
  assert.match(adversarial, /Good triggers include requests to challenge the design, challenge tradeoffs, pressure-test a risky change, question whether a migration\/config\/template change really removed the risk, or honor custom focus text that asks for harsher review/i);
  assert.match(adversarial, /If the user wants Claude Code to go beyond review and perform investigation, validation edits, or implementation work, route to `\$cc:rescue` instead/i);
  assert.match(adversarial, /If the user asks for a local review plus a separate Claude background review and then wants the main Codex thread to aggregate the findings and apply fixes, keep the delegated Claude portion on `\$cc:review` unless the user explicitly asks for the adversarial angle/i);
  assert.match(adversarial, /Unlike `\$cc:review`, this skill accepts custom focus text after the flags/i);
  assert.match(adversarial, activeRootPattern);
  assert.match(adversarial, /Treat `--wait` and `--background` as Codex-side execution controls only/i);
  assert.match(adversarial, /Strip them before calling the companion command/i);
  assert.match(adversarial, /The companion review process itself always runs in the foreground/i);
  assert.match(adversarial, /internal runtime reference at `\.\.\/\.\.\/internal-skills\/review-runtime\/runtime\.md`/i);
  assert.match(adversarial, /It is an internal reference document, not a public skill to invoke/i);
  assert.match(adversarial, /adversarial-review --view-state on-success/i);
  assert.match(adversarial, /Foreground adversarial review belongs to the main Codex thread/i);
  assert.match(adversarial, /Do not spawn a review subagent/i);
  assert.match(adversarial, /do not invoke a generic review-runner role/i);
  assert.match(adversarial, /Do not fall back to raw `claude`, `claude-code`, `claude review`, `bash -lc \.\.\.claude\.\.\.`/i);
  assert.match(adversarial, /If the .*companion command fails, surface that failure/i);
  assert.match(adversarial, /For background adversarial review, use Codex's built-in `default` subagent/i);
  assert.match(adversarial, /Do not satisfy background adversarial review by using a generic `claude_review_runner`-style helper role/i);
  assert.match(adversarial, /Never satisfy background adversarial review by running the companion command itself with shell backgrounding/i);
  assert.match(adversarial, /Background here means "spawn the forwarding child via `spawn_agent` and do not wait in the parent turn\."/i);
  assert.match(adversarial, /background-routing-context --kind review --json/i);
  assert.match(adversarial, /internal `--job-id <reserved-job-id>` routing flag/i);
  assert.match(adversarial, /non-empty `ownerSessionId`/i);
  assert.match(adversarial, /omit `--owner-session-id` entirely/i);
  assert.match(adversarial, /spawn_agent/i);
  assert.doesNotMatch(adversarial, /gpt-5/i);
  assert.match(adversarial, /Prefer a self-contained child message over inheriting parent history/i);
  assert.match(adversarial, /adversarial-review --view-state defer/i);
  assert.match(adversarial, /include `--owner-session-id <owner-session-id>` only when the parent resolved a non-empty owner session id/i);
  assert.match(adversarial, /never leave an empty routing placeholder such as `--owner-session-id {2}--job-id`/i);
  assert.match(adversarial, /Background Claude Code adversarial review finished\. Open it with \$cc:result <reserved-job-id>\./i);
  assert.match(adversarial, /use these steering messages instead of embedding the raw review result in the notification/i);
  assert.match(adversarial, /do not embed the raw Claude result inside the notification message/i);
  assert.match(adversarial, /do not include any other prose in that notification message/i);
  assert.match(adversarial, /use that same steering message as the child's own final assistant message instead of echoing the raw review result/i);
  assert.match(adversarial, /Check the subagent session or \$cc:status for progress, then open the completed job with \$cc:result\./i);
  assert.doesNotMatch(adversarial, /claude-companion\.mjs" adversarial-review --background/i);
  assert.doesNotMatch(adversarial, /claude-companion\.mjs" adversarial-review \$ARGUMENTS/i);
});

test("rescue skill keeps --background and --wait as host-side controls only", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const activeRootPattern = /<plugin-root>\/scripts\/claude-companion\.mjs/i;

  assert.match(rescue, /Resolve `<plugin-root>` as two directories above this `SKILL\.md` file/i);
  assert.match(rescue, /Prefer `\$cc:rescue` when the user wants Claude Code to diagnose the issue, validate a risky change by actually editing or testing, apply fixes from a prior review, or carry a task forward across multiple steps/i);
  assert.match(rescue, /Do not use rescue for "just review this diff" unless the user also wants follow-through work beyond review findings/i);
  assert.match(rescue, /Do not use rescue merely because the main Codex thread plans to fix things after combining its own review with a separate Claude review/i);
  assert.match(rescue, activeRootPattern);
  assert.match(rescue, /`--background` and `--wait` are Codex-side execution controls only/i);
  assert.match(rescue, /Never satisfy background rescue by launching `claude-companion\.mjs task` itself as a detached shell process/i);
  assert.match(rescue, /Never forward either flag to `claude-companion\.mjs task`/i);
  assert.match(rescue, /The main Codex thread owns that execution-mode choice/i);
  assert.match(rescue, /If the user explicitly passed `--background`, run the rescue subagent in the background/i);
  assert.match(rescue, /If neither flag is present and the rescue request is small, clearly bounded, or likely to finish quickly, prefer foreground/i);
  assert.match(rescue, /If neither flag is present and the request looks complicated, open-ended, multi-step, or likely to keep Claude Code running for a while, prefer background execution for the subagent/i);
  assert.match(rescue, /This size-and-scope heuristic belongs to the main Codex thread/i);
  assert.match(rescue, /If the user task text itself begins with a slash command such as `\/simplify`/i);
  assert.match(rescue, /Remove `--background` and `--wait` before spawning the subagent/i);
  assert.match(rescue, /If the free-text task begins with `\/`, preserve it verbatim/i);
  assert.match(rescue, /background-routing-context --kind task --json/i);
  assert.match(rescue, /non-empty `ownerSessionId`/i);
  assert.match(rescue, /omit `--owner-session-id` entirely/i);
  assert.match(rescue, /internal `--job-id <reserved-job-id>` routing flag/i);
  assert.match(rescue, /Foreground rescue must add `--view-state on-success`/i);
  assert.match(rescue, /Background rescue must add `--view-state defer`/i);
  assert.match(rescue, /Background: spawn the rescue subagent without waiting for it in this turn/i);
  assert.match(rescue, /The subagent still runs the companion `task` command in the foreground/i);
  assert.match(rescue, /tell the user `Claude Code rescue started in the background\. Check the subagent session or \$cc:status for progress, then open the completed job with \$cc:result\.`/i);
});

test("rescue skill documents the experimental built-in-agent forwarding path", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const rescueAgentMeta = read("skills/rescue/agents/openai.yaml");
  const frontmatter = rescue.split("---")[1] ?? "";
  const supportedArgumentsLine =
    rescue
      .split("\n")
      .find((line) => line.startsWith("Supported arguments:")) ?? "";

  assert.doesNotMatch(frontmatter, /--builtin-agent/i);
  assert.doesNotMatch(supportedArgumentsLine, /--builtin-agent/i);
  assert.doesNotMatch(rescueAgentMeta, /--builtin-agent/i);
  assert.doesNotMatch(frontmatter, /--notify-parent-on-complete/i);
  assert.doesNotMatch(supportedArgumentsLine, /--notify-parent-on-complete/i);
  assert.doesNotMatch(rescueAgentMeta, /--notify-parent-on-complete/i);
  assert.match(rescue, /By default, hand this skill off through Codex's built-in `default` subagent/i);
  assert.match(rescue, /legacy request still includes `--builtin-agent`/i);
  assert.match(rescue, /legacy request still includes `--notify-parent-on-complete`/i);
  assert.match(rescue, /compatibility alias for the default built-in path/i);
  assert.doesNotMatch(rescue, /gpt-5/i);
  assert.match(rescue, /non-empty `parentThreadId`/i);
  assert.match(rescue, /pass it into the child prompt as the parent thread id/i);
  assert.match(rescue, /Background Claude Code rescue finished\. Open it with \$cc:result <reserved-job-id>\./i);
  assert.match(rescue, /fall back to:/i);
  assert.match(rescue, /Background Claude Code rescue finished\. Inspect it with \$cc:status first, then use \$cc:result for the finished job you want to open\./i);
  assert.match(rescue, /prefer these steering messages over embedding the raw result text/i);
  assert.match(rescue, /do not embed the raw Claude result inside the notification message/i);
  assert.match(rescue, /do not include any other prose in that notification message/i);
  assert.match(rescue, /for background rescue, use that same steering message as the child's own final assistant message instead of echoing the raw companion result/i);
  assert.match(rescue, /the parent thread owns prompt shaping/i);
  assert.match(rescue, /If the built-in rescue request is vague, chatty, or a follow-up, the parent may tighten only the task text/i);
  assert.match(rescue, /Prefer passing a small structured `<parent_context>` block instead of forked thread history/i);
  assert.match(rescue, /internal runtime reference at `\.\.\/\.\.\/internal-skills\/cli-runtime\/runtime\.md`/i);
  assert.match(rescue, /It is an internal reference document, not a public skill to invoke/i);
  assert.match(rescue, /internal prompt-shaping reference at `\.\.\/\.\.\/internal-skills\/task-prompt-shaping\/prompt-shaping\.md`/i);
  assert.match(rescue, /It is an internal reference document, not a public skill to invoke/i);
  assert.match(rescue, /If the request is already concrete, keep it literal/i);
  assert.match(rescue, /If the request names a concrete file, path, or artifact such as `README\.md`/i);
  assert.match(rescue, /Do not compress it into a shorter delta/i);
  assert.match(rescue, /materialize it into a temporary prompt file first and use `--prompt-file` instead of embedding the task directly/i);
  assert.match(rescue, /multi-line task text/i);
  assert.match(rescue, /single quotes, backticks, or XML-style blocks/i);
  assert.match(rescue, /absolute `--prompt-file` path/i);
  assert.match(rescue, /temporary path outside the repository checkout/i);
  assert.match(rescue, /normal file-write tool or other structured write path/i);
  assert.match(rescue, /rewrite it into a short delta that names the next thing Claude Code should change or inspect/i);
  assert.match(rescue, /preserve the language mix and only tighten the execution intent/i);
  assert.match(rescue, /make that output contract explicit instead of broadening the task/i);
  assert.match(rescue, /For `--resume`, `--resume-last`, vague follow-ups, or ambiguous continuation requests, prefer adding a compact `<parent_context>` block/i);
  assert.match(rescue, /Keep `<parent_context>` small and structured/i);
  assert.match(rescue, /`mode` \(`fresh` or `resume`\)/i);
  assert.match(rescue, /`job_id` when the parent reserved one/i);
  assert.match(rescue, /`claude_session` when a resumable Claude session is already known/i);
  assert.match(rescue, /`next_delta` for the exact next objective/i);
  assert.match(rescue, /Do not use `<parent_context>` for already-clear fresh tasks unless it adds real value/i);
  assert.match(rescue, /Do not turn it into a free-form summary of the whole parent thread/i);
  assert.match(rescue, /prefer a short delta instruction for resume follow-ups/i);
  assert.match(rescue, /The child must not do an additional interpretation pass/i);
  assert.match(rescue, /prefer `--resume` or `--resume-last` with a short delta instruction/i);
  assert.match(rescue, /compact strict forwarding message/i);
  assert.match(rescue, /transient forwarding worker for Claude Code rescue/i);
  assert.match(rescue, /include exactly one shell command to run/i);
  assert.match(rescue, /ignore stderr progress chatter such as `\[cc\] \.\.\.` lines/i);
  assert.match(rescue, /not to inspect the repository, read files, grep, or do the task directly/i);
  assert.match(rescue, /for foreground rescue only, tell the child to return that command's stdout text exactly/i);
  assert.match(rescue, /copy the resolved rescue task text byte-for-byte/i);
  assert.match(rescue, /forbid appending terminal punctuation, adding quotes, dropping prefixes such as `completed:`/i);
  assert.match(rescue, /completed:\/simplify make the output compact/i);
});

test("rescue runtime guidance forbids task --background", () => {
  const runtimeSkill = read("internal-skills/cli-runtime/runtime.md");

  assert.match(runtimeSkill, /`--background` and `--wait` are parent-side execution controls only/i);
  assert.match(runtimeSkill, /Strip both before building the `task` command/i);
  assert.match(runtimeSkill, /Never call `task --background` or invent `task --wait`\./i);
  assert.match(runtimeSkill, /The companion task command always runs in the foreground/i);
  assert.match(runtimeSkill, /`--owner-session-id`, and `--job-id` as routing controls/i);
  assert.match(runtimeSkill, /If the free-text task begins with `\/`, treat that slash command as literal Claude Code task text/i);
  assert.match(runtimeSkill, /Do not add `--quiet-progress` by default for built-in rescue forwarding/i);
  assert.match(runtimeSkill, /Let companion stderr progress remain available in the spawned agent thread/i);
  assert.match(runtimeSkill, /prefer staging it in a temporary prompt file and pass it through `--prompt-file` instead of inlining it in one shell string/i);
  assert.match(runtimeSkill, /prefer a temporary path outside the repository checkout/i);
  assert.match(runtimeSkill, /Use a structured file-write path to create that prompt file/i);
  assert.match(runtimeSkill, /ignore the progress chatter and preserve only the final stdout-equivalent result text/i);
  assert.match(runtimeSkill, /It does not change the companion command you build/i);
  assert.match(runtimeSkill, /`--view-state on-success` means the user will see this companion result in the current turn/i);
  assert.match(runtimeSkill, /`--view-state defer` means the parent is not waiting/i);
  assert.match(runtimeSkill, /`--owner-session-id <session-id>` is an internal parent-session routing control/i);
});

test("rescue parent skill owns resume-candidate exploration", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const runtimeSkill = read("internal-skills/cli-runtime/runtime.md");

  assert.match(rescue, /task-resume-candidate --json/i);
  assert.match(rescue, /Continue current Claude Code thread/i);
  assert.match(rescue, /Start a new Claude Code thread/i);

  assert.doesNotMatch(runtimeSkill, /task-resume-candidate --json/i);
  assert.doesNotMatch(runtimeSkill, /Continue current Claude Code thread/i);
  assert.doesNotMatch(runtimeSkill, /Start a new Claude Code thread/i);
  assert.match(runtimeSkill, /The parent rescue skill already owns that choice/i);
});

test("setup skill repairs native plugin hook feature gates before the final setup report", () => {
  const setup = read("skills/setup/SKILL.md");

  assert.match(setup, /Resolve `<plugin-root>` as two directories above this `SKILL\.md` file/i);
  assert.match(setup, /<plugin-root>\/scripts\/claude-companion\.mjs/i);
  assert.match(setup, /setup --json/i);
  assert.match(setup, /missing native plugin hook features/i);
  assert.match(setup, /hook trust/i);
  assert.match(setup, /\[features\]\.hooks/i);
  assert.doesNotMatch(setup, /plugin_hooks/i);
  assert.match(setup, /native hook trust hashes/i);
  assert.match(setup, /plugin-data destination .* writable-root list/i);
  assert.match(setup, /restart Codex and rerun the same setup command/i);
  assert.doesNotMatch(setup, /install-hooks\.mjs/i);
});

test("simple runtime skills resolve the active plugin root from the skill path", () => {
  const status = read("skills/status/SKILL.md");
  const result = read("skills/result/SKILL.md");
  const cancel = read("skills/cancel/SKILL.md");
  const activeRootPattern = /<plugin-root>\/scripts\/claude-companion\.mjs/i;

  for (const skillText of [status, result, cancel]) {
    assert.match(skillText, /Resolve `<plugin-root>` as two directories above this `SKILL\.md` file/i);
    assert.match(skillText, activeRootPattern);
    assert.doesNotMatch(skillText, /<installed-plugin-root>/i);
  }
});

test("review skills never hard-require a question tool the thread may not have", () => {
  const contracts = ["skills/review/SKILL.md", "skills/adversarial-review/SKILL.md"];

  for (const contractPath of contracts) {
    const contract = read(contractPath);
    // AskUserQuestion is a Claude Code tool; Codex has no tool by that name.
    assert.doesNotMatch(
      contract,
      /AskUserQuestion/,
      `${contractPath} must not name a Claude Code tool as Codex's question tool`
    );
    assert.match(
      contract,
      /request_user_input/,
      `${contractPath} must name Codex's own question tool`
    );
    assert.match(
      contract,
      /only when this thread actually has one/i,
      `${contractPath} must make the ask conditional on that tool existing`
    );
    assert.match(
      contract,
      /current mode permits the call/i,
      `${contractPath} must obey the host's current question-tool mode`
    );
    assert.match(contract, /proceed with the recommended mode/i);
  }
});

// These checks target harmful cross-host instructions and reference integrity.
// The mock-provider E2E suite exercises tool dispatch separately; static text
// checks cannot prove that a model will choose or execute the intended tools.
test("all delegation entrypoints link to the shared host contract", () => {
  for (const contractPath of [
    "skills/rescue/SKILL.md",
    "skills/review/SKILL.md",
    "skills/adversarial-review/SKILL.md",
    "internal-skills/cli-runtime/runtime.md",
    "internal-skills/review-runtime/runtime.md",
  ]) {
    const contract = read(contractPath);
    const reference = contract.match(/\[shared host execution contract\]\(([^)]+)\)/)?.[1];
    assert.ok(reference, `${contractPath} must link its host execution contract`);
    assert.equal(
      path.resolve(PROJECT_ROOT, path.dirname(contractPath), reference),
      path.join(PROJECT_ROOT, "internal-skills/host-runtime/runtime.md"),
    );
    assert.doesNotMatch(contract, /require_escalated|fork_context:|reasoning_effort:|send_input\(/);
    assert.doesNotMatch(contract, /wait for command exit in that same call|do not request a shell session id/i);
  }
});

test("host execution contract handles CLI and app capability differences", () => {
  const host = read("internal-skills/host-runtime/runtime.md");
  for (const capability of ["fork_turns", "fork_context", "write_stdin", "sandbox_permissions"]) {
    assert.ok(host.includes(capability), `missing host capability ${capability}`);
  }
  assert.match(host, /Never send both fields or invent an unsupported field/);
  assert.match(host, /Omit `agent_type`, `model`, and `reasoning_effort` by default/);
  assert.match(host, /If no built-in agent is available or delegation is disabled/);
  assert.match(host, /Never relaunch the command after a yield/);
  assert.match(host, /forbidden by policy, omit it/);
  assert.match(host, /never require a tool named `send_input`/);
  assert.match(host, /Parent IDs and collaboration-agent addresses belong to different tool APIs/);
  assert.match(host, /does not change job ownership or mark a deferred result viewed/);
});

test("setup distinguishes read-only diagnostics from authorized repairs", () => {
  const setup = read("skills/setup/SKILL.md");
  assert.match(setup, /setup --check --json/);
  assert.match(setup, /Normal `setup` is a mutating repair operation/);
  assert.match(setup, /`--check` cannot be combined with/);
  assert.match(setup, /CC_PLUGIN_CODEX_AUTH_MODE=subscription/);
});
