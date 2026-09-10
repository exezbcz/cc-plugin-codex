# Maintaining this derivative

The upstream remote is Sendbird's public `cc-plugin-codex` repository. The starting revision is recorded in IMPLEMENTATION_PLAN.md. Retain LICENSE, NOTICE and attribution when sharing modifications.

Keep each behavioral patch and its regression tests together. Before bringing in new upstream commits, review authentication, execution flags, installers, hooks and workflow changes. Do not merge an upstream release merely to change a local cache version.

Run `npm run check`, `npm audit`, and the public-source scan before release. Run Gitleaks locally with redaction across all Git history. Review scanner findings privately: do not paste raw matches into public issues or CI logs. Verify the npm archive file list, which is controlled by package.json's explicit files allowlist.

The npm package is private to prevent accidental publication under an unintended identity. There are no automatic npm publish or upstream-marketplace update workflows in this derivative. GitHub publication is a separate operation after the source and history checks.

Local marketplace registration and installed caches are user-specific and must never be committed. Use Codex plugin-creator's documented local update/cachebuster workflow and keep package.json and the plugin manifest versions synchronized. Test a fresh task after reinstall; already running tasks may retain old skill instructions.

The installer keeps source registration and saved results on uninstall. Removing historical runtime data is an explicit local maintenance action, not part of a public-source update. Do not sweep other marketplace entries or installations simply because their plugin name is also cc.
