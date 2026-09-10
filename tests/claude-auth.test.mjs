/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readClaudeAuthStatus, findSubscriptionConflicts, resolveAuthMode, sanitizeClaudeDiagnostic,
} from "../scripts/lib/claude-auth.mjs";
import { runClaudeTurn, runClaudeReview } from "../scripts/lib/claude-cli.mjs";
import { resolveExpectedPluginDataRoot } from "../scripts/lib/codex-paths.mjs";

const subscription = {
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max",
  email: "synthetic@example.invalid", orgId: "synthetic-org", accessToken: "synthetic-token",
};
function absentFile() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
function statusOptions(overrides = {}) {
  return {
    env: { CC_PLUGIN_CODEX_AUTH_MODE: "subscription", HOME: "/synthetic/home" },
    readFile: absentFile,
    spawnSync: () => ({ status: 0, stdout: JSON.stringify(subscription), stderr: "synthetic-private-output" }),
    ...overrides,
  };
}

describe("Claude subscription authentication", () => {
  it("defaults to inherited authentication without changing credentials", () => {
    assert.equal(resolveAuthMode({}), "inherit");
    assert.throws(() => resolveAuthMode({ CC_PLUGIN_CODEX_AUTH_MODE: "secret-invalid-mode" }),
      { message: "CC_PLUGIN_CODEX_AUTH_MODE must be inherit or subscription." });
    const env = { ANTHROPIC_API_KEY: "synthetic-secret" };
    const result = readClaudeAuthStatus("/workspace", statusOptions({ env,
      spawnSync: (_bin, _args, opts) => {
        assert.strictEqual(opts.env, env);
        return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }) };
      },
    }));
    assert.equal(result.ready, true);
    assert.equal(result.mode, "inherit");
    assert.equal(env.ANTHROPIC_API_KEY, "synthetic-secret");
  });

  it("reports only whitelisted non-identifying CLI status fields", () => {
    const result = readClaudeAuthStatus("/workspace", statusOptions());
    assert.equal(result.ready, true);
    assert.equal(result.authMethod, "claude.ai");
    assert.equal(result.subscriptionType, "max");
    assert.equal(result.tokenValidated, false);
    assert.match(result.detail, /CLI reports signed in/);
    assert.match(result.detail, /token validity was not checked/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic|email|orgId|accessToken/);
  });

  it("passes the same cwd, environment and explicit settings to the CLI status command", () => {
    const env = { CC_PLUGIN_CODEX_AUTH_MODE: "subscription", HOME: "/synthetic/home" };
    readClaudeAuthStatus("/worktree", statusOptions({ env, settingSources: "", settingsFile: '{"disableAllHooks":true}',
      spawnSync: (bin, args, options) => {
        assert.equal(bin, "claude");
        assert.deepEqual(args, ["--setting-sources", "", "--settings", '{"disableAllHooks":true}', "auth", "status", "--json"]);
        assert.equal(options.cwd, "/worktree");
        assert.strictEqual(options.env, env);
        return { status: 0, stdout: JSON.stringify(subscription) };
      },
    }));
  });

  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_PROFILE", "CLAUDE_CODE_SIMPLE"]) {
    it(`blocks ${key} without disclosing its value or invoking a helper`, () => {
      const result = readClaudeAuthStatus("/workspace", statusOptions({
        env: { CC_PLUGIN_CODEX_AUTH_MODE: "subscription", [key]: "synthetic-secret" },
        spawnSync: () => { assert.fail("preflight must stop before CLI execution"); },
      }));
      assert.equal(result.ready, false);
      assert.ok(result.conflicts.some((conflict) => conflict.includes(key)));
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
    });
  }

  it("detects helpers and credential overrides in selected settings without running them", () => {
    const readFile = (file) => file.endsWith("settings.json")
      ? JSON.stringify({ apiKeyHelper: "synthetic-secret-command", env: { ANTHROPIC_API_KEY: "fake-secret-key-for-test" } })
      : absentFile();
    const conflicts = findSubscriptionConflicts("/workspace", statusOptions({ readFile }));
    assert.ok(conflicts.includes("user settings: apiKeyHelper"));
    assert.ok(conflicts.includes("project settings: ANTHROPIC_API_KEY"));
    assert.doesNotMatch(JSON.stringify(conflicts), /synthetic-secret|fake-secret/);
  });

  it("does not inspect ignored user/project settings or credential stores", () => {
    const files = [];
    const result = readClaudeAuthStatus("/workspace", statusOptions({ settingSources: "", readFile: (file) => {
      files.push(file);
      return absentFile();
    } }));
    assert.equal(result.ready, true);
    assert.ok(files.every((file) => file.endsWith("managed-settings.json")));
  });

  it("fails closed when explicit settings are missing or invalid", () => {
    const result = readClaudeAuthStatus("/workspace", statusOptions({ settingsFile: "/missing/settings.json" }));
    assert.equal(result.ready, false);
    assert.deepEqual(result.conflicts, ["explicit settings: unreadable or invalid settings"]);
  });

  it("does not accept an API identity, unknown provider, or absent plan as a subscription", () => {
    for (const changes of [{ authMethod: "api_key" }, { apiProvider: "bedrock" },
      { subscriptionType: null }, { authMethod: "synthetic-private-output" }]) {
      const result = readClaudeAuthStatus("/workspace", statusOptions({
        spawnSync: () => ({ status: 0, stdout: JSON.stringify({ ...subscription, ...changes }) }),
      }));
      assert.equal(result.ready, false);
      assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    }
  });

  it("does not treat exit zero alone or malformed JSON as authenticated", () => {
    for (const stdout of ["authenticated", "null", "[]", '{"loggedIn":false}']) {
      const result = readClaudeAuthStatus("/workspace", statusOptions({ spawnSync: () => ({ status: 0, stdout }) }));
      assert.equal(result.ready, false);
      assert.equal(result.loggedIn, false);
    }
  });

  it("sanitizes missing CLI, timeouts and failed status checks", () => {
    for (const response of [
      { status: 1, stdout: JSON.stringify(subscription), stderr: "synthetic-token" },
      { error: { code: "ETIMEDOUT", message: "synthetic-token" } },
      { error: { code: "ENOENT", message: "synthetic-token" } },
    ]) {
      const result = readClaudeAuthStatus("/workspace", statusOptions({ spawnSync: () => response }));
      assert.equal(result.ready, false);
      assert.equal(result.available, response.error?.code !== "ENOENT");
      assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    }
  });

  it("redacts credential values, bearer tokens and identity from diagnostics", () => {
    const value = sanitizeClaudeDiagnostic(
      "synthetic-api-value Bearer synthetic-token user@example.invalid sk-ant-test-123",
      { ANTHROPIC_API_KEY: "synthetic-api-value" },
    );
    assert.doesNotMatch(value, /synthetic|user@example|sk-ant/);
    assert.match(value, /redacted/);
  });

  it("refuses a subscription run before model spawn when credentials conflict", async () => {
    await assert.rejects(runClaudeTurn("/workspace", "private prompt", {
      env: { CC_PLUGIN_CODEX_AUTH_MODE: "subscription", ANTHROPIC_API_KEY: "synthetic-secret" },
    }), /subscription mode blocked/);
  });
});

// Executable fixtures exercise the real subprocess boundary without contacting
// Claude. Native Windows cannot execute POSIX shebang fixtures.
describe("auth preflight subprocess contract", { skip: process.platform === "win32" }, () => {
  it("preflights each subscription call with the execution environment/settings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-contract-"));
    const log = path.join(dir, "calls.jsonl");
    const bin = path.join(dir, "fake-claude");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args, cwd: process.cwd(), marker: process.env.FIXTURE_MARKER, home: process.env.HOME }) + "\\n");
if (args.includes("auth") && args.includes("status")) process.stdout.write(JSON.stringify(${JSON.stringify(subscription)}));
else if (args[0] === "-p") { process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({type:"result", result:"complete", session_id:"fixture"}) + "\\n")); }
else process.exitCode = 2;
`, { mode: 0o700 });
    const env = {
      PATH: process.env.PATH, HOME: dir, USERPROFILE: dir,
      CC_PLUGIN_CODEX_AUTH_MODE: "subscription", CC_PLUGIN_CODEX_CLAUDE_BIN: bin,
      FIXTURE_LOG: log, FIXTURE_MARKER: "synthetic-context",
    };
    try {
      const result = await runClaudeReview(dir, "fixture-only prompt", { env, mcpConfigFile: '{"mcpServers":{}}' });
      assert.equal(result.status, "completed");
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(calls.length, 2);
      assert.ok(calls[0].args.includes("auth"));
      assert.equal(calls[1].args[0], "-p");
      for (const call of calls) {
        assert.equal(call.cwd, fs.realpathSync(dir));
        assert.equal(call.marker, "synthetic-context");
        assert.equal(call.home, dir);
      }
      for (const flag of ["--settings", "--setting-sources"]) {
        assert.equal(calls[0].args[calls[0].args.indexOf(flag) + 1], calls[1].args[calls[1].args.indexOf(flag) + 1]);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("setup --check does not create config, plugin state, hook trust, or invoke the app server", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-setup-check-"));
    const bin = path.join(dir, "fake-claude");
    fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === "--version") process.stdout.write("2.1.197 (Claude Code)");
else if (process.argv[2] === "auth") process.stdout.write(JSON.stringify(${JSON.stringify(subscription)}));
else process.exitCode=2;
`, { mode: 0o700 });
    const codexHome = path.join(dir, "codex-home");
    const companion = fileURLToPath(new URL("../scripts/claude-companion.mjs", import.meta.url));
    const env = {
      ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: codexHome,
      CC_PLUGIN_CODEX_CLAUDE_BIN: bin, CC_PLUGIN_CODEX_AUTH_MODE: "inherit",
      CC_PLUGIN_CODEX_FORCE_HOOK_TRUST: "1", CC_PLUGIN_CODEX_APP_SERVER_COMMAND: "must-not-run",
    };
    try {
      const before = fs.readdirSync(dir);
      const result = spawnSync(process.execPath, [companion, "setup", "--check", "--cwd", dir, "--json"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.checkOnly, true);
      assert.equal(report.auth.ready, true);
      assert.equal(report.auth.tokenValidated, false);
      assert.equal(report.localAuthReady, true);
      assert.equal(report.ready, false);
      assert.equal(report.integrationStatus, "not_verified");
      assert.deepEqual(report.actionsTaken, []);
      assert.equal(report.hookTrust.attempted, false);
      assert.deepEqual(fs.readdirSync(dir), before);
      assert.doesNotMatch(result.stdout, /synthetic@example|synthetic-org|synthetic-token/);
      const conflict = spawnSync(process.execPath, [companion, "setup", "--check", "--enable-review-gate", "--cwd", dir], { env, encoding: "utf8" });
      assert.notEqual(conflict.status, 0);
      assert.match(conflict.stderr, /--check cannot be combined/);
      assert.deepEqual(fs.readdirSync(dir), before);

      // Having enabled hooks and an accessible state directory does not prove
      // hook trust or that Codex's current sandbox permits state writes.
      const pluginRoot = path.resolve(path.dirname(companion), "..");
      fs.mkdirSync(resolveExpectedPluginDataRoot(pluginRoot, codexHome), { recursive: true });
      const configFile = path.join(codexHome, "config.toml");
      const config = '[features]\nhooks = true\n[hooks.state."fixture-untrusted"]\ntrusted_hash = ""\n';
      fs.writeFileSync(configFile, config);
      const configured = spawnSync(process.execPath, [companion, "setup", "--check", "--cwd", dir, "--json"], { env, encoding: "utf8" });
      assert.equal(configured.status, 0, configured.stderr);
      const diagnostic = JSON.parse(configured.stdout);
      assert.equal(diagnostic.hooks.installed, true);
      assert.equal(diagnostic.pluginState.accessible, true);
      assert.equal(diagnostic.pluginState.ready, null);
      assert.equal(diagnostic.pluginState.writeAccessVerified, false);
      assert.equal(diagnostic.hookTrust.ready, null);
      assert.equal(diagnostic.hookTrust.attempted, false);
      assert.equal(diagnostic.localAuthReady, true);
      assert.equal(diagnostic.ready, false);
      assert.equal(diagnostic.integrationStatus, "not_verified");
      assert.deepEqual(diagnostic.actionsTaken, []);
      const rendered = spawnSync(process.execPath, [companion, "setup", "--check", "--cwd", dir], { env, encoding: "utf8" });
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.match(rendered.stdout, /Status: not verified \(diagnostic only\)/);
      assert.doesNotMatch(rendered.stdout, /Status: ready/);
      assert.equal(fs.readFileSync(configFile, "utf8"), config);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
