/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPublicSource, isPersonalArtifact, scanPublicText } from "../scripts/check-public-source.mjs";

const fixtureRoots = [];
const scanner = fileURLToPath(new URL("../scripts/check-public-source.mjs", import.meta.url));
const syntheticToken = () => ["sk", "ant", "api03", "a".repeat(80)].join("-");

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-public-source-"));
  fixtureRoots.push(root);
  git(root, ["init", "-q"]);
  write(root, "package.json", JSON.stringify({ name: "publication-test", files: ["scripts"] }));
  write(root, "scripts/example.mjs", 'console.log("example");\n');
  git(root, ["add", "."]);
  return root;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("public-source content rules", () => {
  it("rejects runtime files, credentials, logs, and unsanitized environment files", () => {
    for (const file of [".env", ".env.local", "auth.json", ".credentials.json", ".claude/settings.json", ".codex/auth.json", "work/result.md", "jobs/result.json", "transcripts/session.json", "result.jsonl", "debug.log"]) {
      assert.equal(isPersonalArtifact(file), true, file);
    }
    assert.equal(isPersonalArtifact(".env.example"), false);
    assert.equal(isPersonalArtifact(".codex-plugin/plugin.json"), false);
  });

  it("finds recognizable tokens and private keys without returning their contents", () => {
    const secrets = [syntheticToken(), ["ghp", "a".repeat(36)].join("_"), ["-----BEGIN", "PRIVATE KEY-----"].join(" ")];
    for (const secret of secrets) {
      const findings = scanPublicText("README.md", `example\n${secret}\n`);
      assert.ok(findings.length > 0);
      assert.ok(findings.every((finding) => finding.line === 2));
      assert.ok(!JSON.stringify(findings).includes(secret));
    }
  });

  it("never exempts token material merely because it appears in a test", () => {
    assert.ok(scanPublicText("tests/example.test.mjs", syntheticToken()).length > 0);
  });

  it("accepts placeholders but rejects concrete values in an environment example", () => {
    assert.deepEqual(scanPublicText(".env.example", '# Template\nANTHROPIC_API_KEY="<your-key>"\nHOST=\n'), []);
    assert.ok(scanPublicText(".env.example", "HOST=internal-machine\n").some((finding) => finding.rule === "unsanitized-env-example"));
    assert.ok(scanPublicText(".env.example", `ANTHROPIC_API_KEY=${syntheticToken()}\n`).length > 0);
  });

  it("rejects personal home paths while accepting explicit synthetic usernames", () => {
    const personal = ["", "Users", "private-person", "project"].join("/");
    assert.ok(scanPublicText("README.md", personal).some((finding) => finding.rule === "personal-home-path"));
    assert.ok(scanPublicText("tests/example.test.mjs", personal).length > 0);
    assert.deepEqual(scanPublicText("README.md", "/home/example/project"), []);
    assert.deepEqual(scanPublicText("tests/example.test.mjs", "C:\\Users\\demo\\project"), []);
  });
});

describe("public-source candidate collection", () => {
  it("accepts a clean repository", () => {
    assert.deepEqual(checkPublicSource(fixture()), []);
  });

  it("checks staged content even when the working file has been cleaned", () => {
    const root = fixture();
    write(root, "scripts/example.mjs", syntheticToken());
    git(root, ["add", "scripts/example.mjs"]);
    write(root, "scripts/example.mjs", "// Clean working copy\n");
    assert.ok(checkPublicSource(root).some((finding) => finding.rule === "anthropic-token:index"));
  });

  it("checks non-ignored untracked candidates before staging", () => {
    const root = fixture();
    write(root, "new-source.md", syntheticToken());
    assert.ok(checkPublicSource(root).some((finding) => finding.file === "new-source.md"));
  });

  it("checks ignored files inside the package allowlist", () => {
    const root = fixture();
    write(root, ".gitignore", "*.local\n");
    write(root, "scripts/private.local", syntheticToken());
    assert.ok(checkPublicSource(root).some((finding) => finding.file === "scripts/private.local"));
  });

  it("rejects forced tracked personal artifacts without needing their contents", () => {
    const root = fixture();
    write(root, ".gitignore", ".env\n");
    write(root, ".env", "SYNTHETIC=test-value\n");
    git(root, ["add", "-f", ".env"]);
    assert.ok(checkPublicSource(root).some((finding) => finding.rule === "personal-artifact:index"));
  });

  it("does not follow a package symlink outside the repository", { skip: process.platform === "win32" }, () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-public-outside-"));
    fixtureRoots.push(outside);
    write(outside, "synthetic.txt", syntheticToken());
    fs.symlinkSync(path.join(outside, "synthetic.txt"), path.join(root, "scripts", "link"));
    const findings = checkPublicSource(root);
    assert.ok(findings.some((finding) => finding.rule === "external-symlink"));
    assert.ok(!findings.some((finding) => finding.rule.startsWith("anthropic-token")));
  });

  it("does not read a candidate through a replaced parent-directory symlink", { skip: process.platform === "win32" }, () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-public-outside-"));
    fixtureRoots.push(outside);
    write(outside, "example.mjs", syntheticToken());
    fs.rmSync(path.join(root, "scripts"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "scripts"));
    const findings = checkPublicSource(root);
    assert.ok(findings.some((finding) => finding.rule === "symlink-parent:working"));
    assert.ok(!findings.some((finding) => finding.rule.startsWith("anthropic-token")));
  });

  it("rejects package metadata symlinks without reading their target", { skip: process.platform === "win32" }, () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-public-outside-"));
    fixtureRoots.push(outside);
    write(outside, "synthetic.txt", syntheticToken());
    fs.unlinkSync(path.join(root, "package.json"));
    fs.symlinkSync(path.join(outside, "synthetic.txt"), path.join(root, "package.json"));
    const findings = checkPublicSource(root);
    assert.ok(findings.some((finding) => finding.rule === "symlink-package-metadata"));
    assert.ok(!findings.some((finding) => finding.rule.startsWith("anthropic-token")));
  });

  it("fails closed for package glob patterns it does not implement", () => {
    const root = fixture();
    write(root, "package.json", JSON.stringify({ files: ["scripts/**"] }));
    assert.ok(checkPublicSource(root).some((finding) => finding.rule === "unsupported-package-pattern"));
  });

  it("prints only rule, file and line for a rejection", () => {
    const root = fixture();
    const secret = syntheticToken();
    write(root, "README.md", secret);
    const result = spawnSync(process.execPath, [scanner], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    for (const line of result.stderr.trim().split("\n")) {
      assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["file", "line", "rule"]);
    }
  });
});
