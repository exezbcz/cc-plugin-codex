/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTH_OVERRIDE_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SIMPLE",
];
const AUTH_METHODS = new Set(["claude.ai", "api_key", "apiKey", "oauth_token", "none"]);
const API_PROVIDERS = new Set(["firstParty", "bedrock", "vertex", "foundry"]);
const SUBSCRIPTIONS = new Set(["pro", "max", "team", "enterprise"]);

export function resolveAuthMode(env = process.env) {
  const mode = String(env.CC_PLUGIN_CODEX_AUTH_MODE ?? "inherit").trim().toLowerCase();
  if (mode !== "inherit" && mode !== "subscription") {
    throw new Error("CC_PLUGIN_CODEX_AUTH_MODE must be inherit or subscription.");
  }
  return mode;
}

function overrideNames(env) {
  const keys = AUTH_OVERRIDE_KEYS.filter((key) => Boolean(env?.[key]));
  if (env?.ANTHROPIC_BASE_URL &&
      !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)) {
    keys.push("ANTHROPIC_BASE_URL");
  }
  return keys;
}

function settingsConflicts(settings, label) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return [`${label}: invalid settings`];
  }
  const conflicts = overrideNames(settings.env).map((key) => `${label}: ${key}`);
  if (settings.apiKeyHelper) conflicts.push(`${label}: apiKeyHelper`);
  if (settings.forceLoginMethod && settings.forceLoginMethod !== "claudeai") {
    conflicts.push(`${label}: forceLoginMethod`);
  }
  if (settings.forceLoginGatewayUrl) conflicts.push(`${label}: forceLoginGatewayUrl`);
  return conflicts;
}

// Inspect settings only, never .claude.json, .credentials.json, profiles or Keychain.
// The CLI remains the authority on effective credentials and refresh behavior.
export function findSubscriptionConflicts(cwd, options = {}) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((file) => {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("oversized");
    return fs.readFileSync(file, "utf8");
  });
  const conflicts = overrideNames(env).map((key) => `environment: ${key}`);
  const sources = new Set(String(options.settingSources ?? "user,project,local").split(","));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const files = [];
  if (sources.has("user")) files.push([path.join(configDir, "settings.json"), "user settings"]);
  // Include ancestor settings conservatively: their applicability differs across CLI versions.
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (sources.has("project")) files.push([path.join(dir, ".claude", "settings.json"), "project settings"]);
    if (sources.has("local")) files.push([path.join(dir, ".claude", "settings.local.json"), "local settings"]);
    if (path.dirname(dir) === dir) break;
  }
  const platform = options.platform ?? process.platform;
  const managedDir = platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : platform === "win32" ? path.join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode")
      : "/etc/claude-code";
  files.push([path.join(managedDir, "managed-settings.json"), "managed settings"]);
  if (options.settingsFile) {
    if (String(options.settingsFile).trim().startsWith("{")) {
      try { conflicts.push(...settingsConflicts(JSON.parse(options.settingsFile), "explicit settings")); }
      catch { conflicts.push("explicit settings: invalid settings"); }
    } else files.push([path.resolve(cwd, options.settingsFile), "explicit settings"]);
  }
  for (const [file, label] of files) {
    try { conflicts.push(...settingsConflicts(JSON.parse(readFile(file)), label)); }
    catch (error) {
      if (error?.code !== "ENOENT" || label === "explicit settings") {
        conflicts.push(`${label}: unreadable or invalid settings`);
      }
    }
  }
  return [...new Set(conflicts)];
}

/** Auth status and execution must receive the same environment/settings. */
export function readClaudeAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const mode = resolveAuthMode(env);
  // Root options must precede the auth subcommand (verified with CLI 2.1.197).
  const args = [];
  if (options.settingSources != null) args.push("--setting-sources", options.settingSources);
  if (options.settingsFile) args.push("--settings", options.settingsFile);
  args.push("auth", "status", "--json");
  // `ready` means the local status and credential selection pass preflight.
  // auth status does not make a model request or prove that OAuth is unexpired.
  const base = { available: true, loggedIn: false, ready: false, tokenValidated: false, mode,
    authMethod: "unknown", apiProvider: "unknown", subscriptionType: null, conflicts: [] };
  const conflicts = mode === "subscription" ? findSubscriptionConflicts(cwd, options) : [];
  // Do not invoke helpers when an explicitly subscription-only request has a conflict.
  if (conflicts.length) return { ...base, conflicts,
    detail: "subscription mode blocked by credential overrides or ambiguous settings; resolve the listed conflicts or explicitly choose inherit mode" };
  let result;
  try {
    result = (options.spawnSync ?? spawnSync)(options.bin ?? "claude", args, {
      cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
      windowsHide: true,
    });
  } catch { return { ...base, detail: `${mode} mode: unable to check Claude authentication` }; }
  if (result.error) return { ...base, available: result.error.code !== "ENOENT",
    detail: `${mode} mode: Claude authentication check could not finish` };
  let status;
  try { status = JSON.parse(result.stdout); }
  catch { return { ...base, detail: `${mode} mode: Claude returned invalid auth status JSON; update or repair the CLI` }; }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return { ...base, detail: `${mode} mode: Claude returned invalid auth status JSON` };
  }
  const authMethod = AUTH_METHODS.has(status.authMethod) ? status.authMethod : "unknown";
  const apiProvider = API_PROVIDERS.has(status.apiProvider) ? status.apiProvider : "unknown";
  const subscriptionType = SUBSCRIPTIONS.has(status.subscriptionType) ? status.subscriptionType : null;
  const loggedIn = result.status === 0 && status.loggedIn === true;
  const ready = loggedIn && (mode === "inherit" ||
    (authMethod === "claude.ai" && apiProvider === "firstParty" && subscriptionType != null));
  return { ...base, loggedIn, ready, authMethod, apiProvider, subscriptionType,
    detail: !loggedIn ? `${mode} mode: not authenticated — run claude auth login`
      : !ready ? "subscription mode: active authentication is not a verified Claude subscription; no model request was started"
        : `${mode} mode: CLI reports signed in (${authMethod}, ${apiProvider}${subscriptionType ? `, ${subscriptionType}` : ""}); token validity was not checked` };
}

/** Do not persist credential values echoed by a CLI error. */
export function sanitizeClaudeDiagnostic(text, env = process.env) {
  let sanitized = String(text ?? "");
  for (const [key, value] of Object.entries(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && value && value.length >= 4) {
      sanitized = sanitized.split(value).join("[redacted]");
    }
  }
  return sanitized.replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]");
}
