# Validation of 1.5.1-local.1

The complete `npm run check` pipeline passed:

- 570 unit tests.
- 45 integration tests.
- 26 end-to-end tests using the real Codex CLI, a local synthetic model provider and a fake Claude executable.
- Version/changelog consistency, ESLint, TypeScript and public-source checks.

All 641 tests passed without skips. These tests do not make paid model calls. Relevant execution fixtures pin their fake executable/authentication mode so caller configuration cannot route them to a real Claude binary.

The plugin manifest passed the Codex plugin validator; edited skills passed the skill validator. Dependency auditing reported no known vulnerabilities after updating the affected development dependencies. The runtime has no third-party npm dependencies.

Local installation through the personal marketplace succeeded. Critical installed files matched the tested source hashes. Native hook setup succeeded. Local authentication metadata can establish configuration/sign-in state but does not validate a token against a model endpoint.

Gitleaks scanned the inherited 103-commit history and the extracted distribution with no recognized secrets found. The archive contained only allowed plugin/documentation/assets files, no tests or symlinks, and no runtime logs or account configuration. Source/index checks complement this history/archive check. These scanners do not prove the absence of every possible form of sensitive data.

Provider-backed verification through the installed plugin completed for review, implementation and resume in a disposable synthetic repository:

- Review identified a deliberate arithmetic defect without modifying files.
- Implementation repaired the defect and passed a local test.
- An explicit resume continued the same Claude session, added the requested regression assertion and passed the test.
- Status and stored result retrieval returned the completed jobs.
- A separate live review exercised Glob, Grep, Read and the bundled Git status/diff MCP tools. The native tool roster excluded Bash, Edit, Write, Agent and Skill. MCP tools connected asynchronously and were verified through successful calls.
- A running delegated Claude subprocess was cancelled through the plugin. Its process group stopped, cancelled status and result persisted, and default status/result views honored the explicit parent owner. This verifies active-process cancellation; long-wait orchestration is separately covered by synthetic E2E tests.

These calls used the existing Claude CLI login in explicit subscription mode. No live verification transcript, account details, session identifiers or machine-specific configuration is part of this repository.

## Fable 5.1 default

The plugin default is pinned to `claude-fable-5-1` across commands and direct review/stop-hook calls. A provider-backed structured review verified both the CLI initialization model and response model as `claude-fable-5-1`, identified a deliberate defect, and left the synthetic source unchanged. Explicit per-call model overrides remain supported; no effort level is forced.
