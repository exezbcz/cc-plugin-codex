#!/usr/bin/env node
/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Local publication check for recognizable secrets and personal runtime files.
 * Scans the Git index, candidate working files, and literal package.files roots.
 * Does not inspect Git history or prove that arbitrary content is non-sensitive.
 * No network requests, credential discovery, or symlink traversal.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** @type {Array<[string, RegExp]>} */
const TOKEN_RULES = [
  ["anthropic-token", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["openai-token", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
];
const SYNTHETIC_USER = /^(?:user|username|example|demo|test|tester|fixture|runner|alice|bob)$/i;
const PLACEHOLDER = /^(?:|<[^>]+>|\$\{[^}]+\}|\[[^\]]+\]|(?:your|example|dummy|fake|test|placeholder|redacted|replace|not-a-real)(?:[-_ ].*)?)$/i;

export function isPersonalArtifact(file) {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.toLowerCase().split("/");
  const name = parts.at(-1);
  return parts.some((part) => [".claude", ".codex", "work", "tasks", "jobs", "transcripts", "logs", "outputs"].includes(part)) ||
    (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) ||
    ["auth.json", ".credentials.json", "credentials.json", ".claude.json", ".npmrc", ".netrc", "id_rsa", "id_ed25519"].includes(name) ||
    /\.(?:log|jsonl|p12|pfx)$/i.test(name);
}

function hasPersonalHomePath(file, line) {
  const patterns = [
    /\/(?:Users|home)\/([^\s/"'`<>\\]+)/g,
    /\b[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)([^\\/\s"'`<>]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      if (SYNTHETIC_USER.test(match[1])) continue;
      // A pre-existing upstream path-comparison fixture, not a user directory.
      // This exception applies only to that exact synthetic path in that test.
      if (file === "tests/fs.test.mjs" &&
          /^[Cc]:\\+Users\\+Jin\\+Repo\b/i.test(line.slice(match.index))) continue;
      return true;
    }
  }
  return false;
}

export function scanPublicText(file, content) {
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    for (const [rule, pattern] of TOKEN_RULES) {
      if (pattern.test(text)) findings.push({ rule, file, line: index + 1 });
    }
    if (hasPersonalHomePath(file, text)) {
      findings.push({ rule: "personal-home-path", file, line: index + 1 });
    }
    // Only concrete quoted assignments are checked, not environment lookups.
    const assignment = text.match(/\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|access_token|refresh_token|client_secret)\b["']?\s*[:=]\s*["']([^"']{20,})["']/);
    if (assignment && !PLACEHOLDER.test(assignment[1])) {
      findings.push({ rule: "secret-assignment", file, line: index + 1 });
    }
    if (path.posix.basename(file) === ".env.example") {
      const envLine = text.trim();
      if (!envLine || envLine.startsWith("#")) continue;
      const example = envLine.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
      const value = example?.[1].replace(/^(["'])(.*)\1$/, "$2");
      if (!example || !PLACEHOLDER.test(value)) {
        findings.push({ rule: "unsanitized-env-example", file, line: index + 1 });
      }
    }
  }
  return findings;
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root, maxBuffer: MAX_FILE_BYTES * 2,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0) throw new Error("git-read-failed");
  return result.stdout;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hasSymlinkParent(root, file) {
  const parts = path.relative(root, path.resolve(root, file)).split(path.sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

export function checkPublicSource(root) {
  const findings = [];
  const candidates = new Set();
  const addFinding = (rule, file, line = 1) => findings.push({ rule, file, line });
  const scan = (file, content, source) => {
    for (const finding of scanPublicText(file, content)) {
      findings.push({ ...finding, rule: `${finding.rule}:${source}` });
    }
  };

  // Read staged blobs too: cleaning the working copy must not hide a staged key.
  for (const entry of git(root, ["ls-files", "--stage", "-z"]).toString("utf8").split("\0")) {
    if (!entry) continue;
    const match = entry.match(/^([0-7]+) ([a-f0-9]{40,64}) [0-3]\t([\s\S]+)$/);
    if (!match) throw new Error("invalid-index-entry");
    const [, mode, objectId, file] = match;
    candidates.add(file);
    if (isPersonalArtifact(file)) {
      addFinding("personal-artifact:index", file);
      continue;
    }
    if (mode === "160000") {
      addFinding("unscanned-submodule:index", file);
      continue;
    }
    const content = git(root, ["cat-file", "blob", objectId]);
    if (content.length > MAX_FILE_BYTES) addFinding("oversized-file:index", file);
    else {
      const text = content.toString("utf8");
      if (mode === "120000" && !isInside(root, path.resolve(root, path.dirname(file), text))) {
        addFinding("external-symlink:index", file);
      }
      scan(file, text, "index");
    }
  }
  for (const file of git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0")) {
    if (file) candidates.add(file);
  }

  const visitPackagePath = (file) => {
    const absolute = path.resolve(root, file);
    if (!isInside(root, absolute)) {
      addFinding("package-path-outside-root", "package.json");
      return;
    }
    if (hasSymlinkParent(root, file)) {
      addFinding("symlink-parent:package", file);
      return;
    }
    if (isPersonalArtifact(file)) {
      if (fs.existsSync(absolute)) addFinding("personal-artifact:package", file);
      return; // Never descend into a personal runtime or credential directory.
    }
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) {
        if (entry === ".git" || entry === "node_modules") continue;
        visitPackagePath(path.posix.join(file, entry));
      }
    } else {
      candidates.add(file);
    }
  };
  const packageFile = path.join(root, "package.json");
  if (fs.existsSync(packageFile) && fs.lstatSync(packageFile).isSymbolicLink()) {
    addFinding("symlink-package-metadata", "package.json");
  } else if (fs.existsSync(packageFile)) {
    const metadata = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (!Array.isArray(metadata.files)) addFinding("missing-package-allowlist", "package.json");
    else for (const item of metadata.files) {
      // Deliberately conservative: this is not an implementation of npm's glob
      // and ignore semantics. Require review if the literal allowlist changes.
      if (typeof item !== "string" || /[*?![\]{}]/.test(item) || path.isAbsolute(item)) {
        addFinding("unsupported-package-pattern", "package.json");
      } else visitPackagePath(item.replace(/^\.\//, ""));
    }
  }

  for (const file of candidates) {
    if (isPersonalArtifact(file)) {
      addFinding("personal-artifact:working", file);
      continue;
    }
    const absolute = path.resolve(root, file);
    if (!isInside(root, absolute)) {
      addFinding("candidate-outside-root", file);
      continue;
    }
    if (hasSymlinkParent(root, file)) {
      addFinding("symlink-parent:working", file);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      if (!isInside(root, path.resolve(path.dirname(absolute), target))) {
        addFinding("external-symlink", file);
      }
      scan(file, target, "working");
    } else if (stat.isFile()) {
      if (stat.size > MAX_FILE_BYTES) addFinding("oversized-file:working", file);
      else scan(file, fs.readFileSync(absolute, "utf8"), "working");
    }
  }
  return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const findings = checkPublicSource(process.cwd());
    for (const finding of findings) console.error(JSON.stringify(finding));
    if (findings.length) process.exitCode = 1;
    else console.log("Public-source check passed (index, working candidates, package allowlist; history not scanned).");
  } catch {
    // Do not echo exception text: paths, command stderr, or JSON errors can
    // contain the very private values this check is meant to protect.
    console.error(JSON.stringify({ rule: "scan-incomplete", file: ".", line: 1 }));
    process.exitCode = 1;
  }
}
