# CC Companion implementation plan

Base: Sendbird cc-plugin-codex v1.5.0, commit `19e565151f35b328a5b9433df351bd8f3818fdc7`.

## Objective

Keep Codex as the orchestrator and delegate bounded tasks to the installed, unmodified Claude Code CLI. Reuse the existing review, rescue, session, job and cancellation implementation. Keep implementation tasks in `bypassPermissions`; preserve a distinct read-only review contract.

## Changes and acceptance criteria

1. **Host compatibility.** Skills use the host's actual tool schema and permission policy. A yielded shell call continues the same process. Foreground/background runs return real results without duplicate calls; notifications may fall back to status/result retrieval.
2. **Authentication.** Add explicit subscription mode while preserving inherited authentication as an option. The authentication probe and model call use the same environment and effective settings. Reject conflicting or unknown billing routes in subscription mode. Return only sanitized status fields; Claude owns all login and credential refresh.
3. **Read-only diagnostics.** `setup --check` reports installation/authentication readiness without changing plugin state, hook trust or Codex configuration and without model inference.
4. **Review behavior.** Restrict actual native tool availability independently of autoapproval. Keep the deliberate read/web tools and bundled Git MCP. Disable inherited hooks/connectors/settings that could expand review behavior. Implementation bypass permissions remain unchanged.
5. **Process reliability.** macOS job identity remains valid across a legitimate executable change, while process-birth mismatches still protect against PID reuse. Test real shell-to-executable transition, cancellation and dead-process handling.
6. **Installation ownership.** Install/update from an explicitly selected catalog, using the personal catalog by default. Uninstall only the selected marketplace-qualified plugin. Preserve other plugins, credentials, source registration and saved results. Do not silently install the upstream release or clean unrelated legacy integrations.
7. **Public-source hygiene.** Commit only plugin code, generic documentation and synthetic tests. Exclude account/config files, tokens, credentials, runtime data, logs, transcripts and personal paths. Check source, Git index, archive contents and Git history before publishing. Remove upstream-specific automatic publishing workflows.

## Verification

- Preserve relevant upstream tests and add focused regressions for changed contracts.
- Run version/changelog checks, lint, typecheck, unit, integration and synthetic-provider E2E tests.
- Validate the manifest and skills with the Codex plugin/skill validators.
- Run dependency auditing, a local public-source check and a redacted Git-history secret scan.
- Inspect a distribution assembled from an explicit allowlist; inspect embedded images before publication.
- After offline checks, exercise bounded real review, implementation, explicit resume and cancellation in a disposable repository. Keep all model outputs and local verification logs outside this source tree.
- Install from the local catalog and verify that the installed cache contains the tested version.

## Objective review

The maintenance cost of a fork is the main tradeoff. Preserve upstream history, API names and structure; keep patches focused, attributable and easy to rebase. Do not introduce a new SDK/MCP layer, database, dashboard or scheduler. Model preference UI and automatic review loops are deferred. Mock tests establish mechanics, not actual model behavior or billing.

An independent review supported the scope, with four refinements: subscription mode must be explicit; a read-only setup flag is sufficient; review restrictions must account for startup behavior; installer cleanup must be scoped to one installation. The initial offline baseline was 559 passing unit/integration tests.

## Data boundary

This plan intentionally contains no account identity, local installation path, configuration snapshot, session ID or verification transcript. Runtime data belongs in Codex's user-local plugin data directory. Public examples use placeholders; tests generate their own fake accounts and processes. Git history scanning and manual review are complementary checks, not a promise to detect every possible secret format.
