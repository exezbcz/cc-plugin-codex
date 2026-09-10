# Validation of 1.5.1-local.1

The complete `npm run check` pipeline passed:

- 568 unit tests.
- 45 integration tests.
- 26 end-to-end tests using the real Codex CLI, a local synthetic model provider and a fake Claude executable.
- Version/changelog consistency, ESLint, TypeScript and public-source checks.

All 639 tests passed without skips. These tests do not make paid model calls. Relevant execution fixtures pin their fake executable/authentication mode so caller configuration cannot route them to a real Claude binary.

The plugin manifest passed the Codex plugin validator; edited skills passed the skill validator. Dependency auditing reported no known vulnerabilities after updating the affected development dependencies. The runtime has no third-party npm dependencies.

Local installation through the personal marketplace succeeded. Critical installed files matched the tested source hashes. Native hook setup succeeded. Local authentication metadata can establish configuration/sign-in state but does not validate a token against a model endpoint.

Gitleaks scanned the inherited 103-commit history and the extracted distribution with no recognized secrets found. The archive contained only allowed plugin/documentation/assets files, no tests or symlinks, and no runtime logs or account configuration. Source/index checks complement this history/archive check. These scanners do not prove the absence of every possible form of sensitive data.

Provider-backed review, implementation and resume verification has not completed for this release. A working local Claude login is required to finish that check. No live verification transcript, account details or machine-specific configuration is part of this repository.
