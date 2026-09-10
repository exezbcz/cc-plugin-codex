/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Modified to exercise exposed host schemas with synthetic provider responses.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url))
);
const COMPANION_SCRIPT = path.join(PROJECT_ROOT, "scripts", "claude-companion.mjs");
const INSTALLER_SCRIPT = path.join(PROJECT_ROOT, "scripts", "installer-cli.mjs");
const RESCUE_SKILL_PATH = path.join(PROJECT_ROOT, "skills", "rescue", "SKILL.md");
const REVIEW_SKILL_PATH = path.join(PROJECT_ROOT, "skills", "review", "SKILL.md");
const ADVERSARIAL_REVIEW_SKILL_PATH = path.join(
  PROJECT_ROOT,
  "skills",
  "adversarial-review",
  "SKILL.md"
);
const SETUP_SKILL_PATH = path.join(PROJECT_ROOT, "skills", "setup", "SKILL.md");

function codexAvailable() {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

it("requires the codex CLI when E2E runs in CI", (t) => {
  if (codexAvailable()) {
    return;
  }

  if (process.env.CI) {
    assert.fail(
      "codex CLI is not available in this CI environment; full E2E coverage requires installing @openai/codex first"
    );
  }

  t.skip("codex CLI is not available in this environment");
});

function createFakeClaudeBinary(binDir, logFile) {
  const claudePath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logFile = process.env.FAKE_CLAUDE_LOG;

function getValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) {
    return null;
  }
  return args[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStdin() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
  }
  return body;
}

async function main() {
  if (args[0] === "--version") {
    process.stdout.write("2.1.90 (Claude Code)\\n");
    return;
  }

  if (args.includes("auth") && args.includes("status")) {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }) + "\\n");
    return;
  }

  if (args[0] !== "-p") {
    process.stderr.write("unexpected arguments: " + JSON.stringify(args) + "\\n");
    process.exitCode = 2;
    return;
  }

  const promptIndex = args.lastIndexOf("--");
  const prompt = promptIndex >= 0 ? args.slice(promptIndex + 1).join(" ") : await readStdin();
  const delayMatch = prompt.match(/\\bdelay=(\\d+)\\b/);
  const delay = delayMatch ? Number(delayMatch[1]) : 25;
  const sessionId =
    getValue("--resume") ||
    getValue("--session-id") ||
    "stub-session";

  if (logFile) {
    fs.appendFileSync(
      logFile,
      JSON.stringify({ args, prompt, sessionId }) + "\\n",
      "utf8"
    );
  }

  const resultText = prompt.includes("multiline")
    ? ["completed:" + prompt, "Finding 1", "Finding 2", "Finding 3"].join("\\n")
    : "completed:" + prompt;

  process.stdout.write(
    JSON.stringify({
      type: "stream_event",
      session_id: sessionId,
      event: {
        delta: {
          type: "text_delta",
          text: resultText,
        },
      },
    }) + "\\n"
  );

  await sleep(delay);

  process.stdout.write(
    JSON.stringify({
      type: "result",
      session_id: sessionId,
      result: resultText,
    }) + "\\n"
  );
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\\n");
  process.exitCode = 1;
});
`;

  fs.writeFileSync(claudePath, source, "utf8");
  fs.chmodSync(claudePath, 0o755);
}

function createEnvironment() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rescue-e2e-"));
  const homeDir = path.join(rootDir, "home");
  const codexHome = path.join(homeDir, ".codex");
  const binDir = path.join(rootDir, "bin");
  const outputFile = path.join(rootDir, "last-message.txt");
  const claudeLogFile = path.join(rootDir, "fake-claude.ndjson");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  createFakeClaudeBinary(binDir, claudeLogFile);

  return {
    rootDir,
    homeDir,
    codexHome,
    outputFile,
    claudeLogFile,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: homeDir,
      USERPROFILE: homeDir,
      FAKE_CLAUDE_LOG: claudeLogFile,
      CC_PLUGIN_CODEX_CLAUDE_BIN: path.join(binDir, "claude"),
      CC_PLUGIN_CODEX_AUTH_MODE: "inherit",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  };
}

function reserveJob(testEnv, kind, cwd = PROJECT_ROOT) {
  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, "background-routing-context", "--kind", kind, "--cwd", cwd, "--json"], {
    cwd, env: testEnv.env, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).jobId;
}

function installHooks(testEnv) {
  const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, "scripts", "install-hooks.mjs")], {
    cwd: PROJECT_ROOT,
    env: testEnv.env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const hooksFile = path.join(testEnv.codexHome, "hooks.json");
  const configFile = path.join(testEnv.codexHome, "config.toml");
  const config = fs.readFileSync(configFile, "utf8");
  assert.ok(!fs.existsSync(hooksFile), "native plugin hooks should not install global hooks");
  assert.match(config, /hooks = true/);
  assert.doesNotMatch(config, /plugin_hooks/);
}

function createLocalMarketplaceFixture(testEnv) {
  const marketplaceRoot = path.join(testEnv.rootDir, "sendbird-marketplace");
  const pluginRoot = path.join(marketplaceRoot, "plugins", "cc");
  fs.rmSync(marketplaceRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
  fs.cpSync(PROJECT_ROOT, pluginRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const relative = path.relative(PROJECT_ROOT, sourcePath);
      return (
        relative === "" ||
        !relative.split(path.sep).some((part) =>
          [".git", "node_modules", "tasks"].includes(part)
        )
      );
    },
  });
  fs.mkdirSync(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "sendbird",
        interface: { displayName: "Sendbird Plugins" },
        plugins: [
          {
            name: "cc",
            source: {
              source: "local",
              path: "./plugins/cc",
            },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_USE",
            },
            category: "Coding",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return marketplaceRoot;
}

function installPlugin(testEnv) {
  const marketplaceRoot = createLocalMarketplaceFixture(testEnv);
  const result = spawnSync(process.execPath, [INSTALLER_SCRIPT, "install"], {
    cwd: PROJECT_ROOT,
    env: {
      ...testEnv.env,
      CC_PLUGIN_CODEX_MARKETPLACE_SOURCE: marketplaceRoot,
      CC_PLUGIN_CODEX_MARKETPLACE_NAME: "sendbird",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const cacheParent = path.join(testEnv.codexHome, "plugins", "cache", "sendbird", "cc");
  const configFile = path.join(testEnv.codexHome, "config.toml");
  const cacheDir = fs.existsSync(cacheParent)
    ? fs
        .readdirSync(cacheParent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(cacheParent, entry.name))
        .find((candidate) =>
          fs.existsSync(path.join(candidate, "scripts", "installer-cli.mjs"))
        )
    : null;

  assert.ok(
    cacheDir,
    "installer should install the plugin into the Codex cache"
  );
  assert.ok(fs.existsSync(configFile), "installer should create a Codex config.toml");
  return cacheDir;
}

function installPluginWithEnv(testEnv, extraEnv = {}) {
  const result = spawnSync(process.execPath, [INSTALLER_SCRIPT, "install"], {
    cwd: PROJECT_ROOT,
    env: {
      ...testEnv.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function createMethodNotFoundCodex(testEnv) {
  const scriptPath = path.join(testEnv.rootDir, "fake-codex-app-server-method-not-found.mjs");
  const logPath = path.join(testEnv.codexHome, "fake-codex-requests.log");

  fs.writeFileSync(
    scriptPath,
    String.raw`import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , logPath] = process.argv;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(message) + "\n", "utf8");

  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\n"
  );
});`,
    "utf8"
  );

  return {
    env: {
      CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
      CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([scriptPath, logPath]),
    },
    logPath,
  };
}

function writeConfigToml(testEnv, port) {
  const configFile = path.join(testEnv.codexHome, "config.toml");
  const existing = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf8").trim()
    : "";
  fs.writeFileSync(
    configFile,
    `model = "mock-model"
approval_policy = "never"
sandbox_mode = "workspace-write"
model_provider = "mock_provider"

${existing}

[model_providers.mock_provider]
name = "Mock provider"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
    "utf8"
  );
}

function cleanupEnvironment(testEnv) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(testEnv.rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19 || !["ENOTEMPTY", "EBUSY"].includes(error?.code)) {
        throw error;
      }
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        // brief sync backoff for detached process cleanup on macOS
      }
    }
  }
}

function buildRescuePrompt(userRequest) {
  const skillBody = fs.readFileSync(RESCUE_SKILL_PATH, "utf8").trim();
  return [
    "<skill>",
    "<name>cc:rescue</name>",
    `<path>${RESCUE_SKILL_PATH}</path>`,
    skillBody,
    "</skill>",
    "",
    userRequest,
  ].join("\n");
}

function buildSkillPrompt(name, skillPath, userRequest) {
  const skillBody = fs.readFileSync(skillPath, "utf8").trim();
  return [
    "<skill>",
    `<name>${name}</name>`,
    `<path>${skillPath}</path>`,
    skillBody,
    "</skill>",
    "",
    userRequest,
  ].join("\n");
}

function buildMultiSkillPrompt(skills, userRequest) {
  return [
    ...skills.flatMap(({ name, path: skillPath }) => {
      const skillBody = fs.readFileSync(skillPath, "utf8").trim();
      return [
        "<skill>",
        `<name>${name}</name>`,
        `<path>${skillPath}</path>`,
        skillBody,
        "</skill>",
        "",
      ];
    }),
    userRequest,
  ].join("\n");
}

function eventCreated(id) {
  return {
    type: "response.created",
    response: { id },
  };
}

function eventCompleted(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function eventAssistantMessage(id, text) {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

function eventFunctionCall(callId, name, args, namespace = null) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      ...(namespace ? { namespace } : {}),
      arguments: JSON.stringify(args),
    },
  };
}

function formatSse(events) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function getToolEntries(body) {
  if (!Array.isArray(body.tools)) {
    return [];
  }

  return body.tools.flatMap((tool) => [
    { tool, namespace: null },
    ...(tool.type === "namespace" && Array.isArray(tool.tools)
      ? tool.tools.map((child) => ({ tool: child, namespace: tool.name }))
      : []),
  ]);
}

function findTool(body, toolName) {
  return getToolEntries(body).find(
    ({ tool }) => (tool.name || tool.function?.name || tool.type) === toolName
  );
}

function getToolNames(body) {
  return getToolEntries(body)
    .map(({ tool }) => tool.name || tool.function?.name || tool.type)
    .filter(Boolean);
}

function getToolNamespace(body, toolName) {
  return findTool(body, toolName)?.namespace ?? null;
}

function chooseShellTool(body) {
  const toolNames = getToolNames(body);
  if (toolNames.includes("exec_command")) {
    return "exec_command";
  }
  if (toolNames.includes("shell_command")) {
    return "shell_command";
  }
  if (toolNames.includes("shell")) {
    return "shell";
  }
  throw new Error(`No supported shell tool found. Saw: ${toolNames.join(", ")}`);
}

function buildShellArgs(toolName, command, cwd = PROJECT_ROOT) {
  if (toolName === "exec_command") {
    return {
      cmd: command,
      workdir: cwd,
      yield_time_ms: 15000,
      max_output_tokens: 12000,
    };
  }

  if (toolName === "shell_command") {
    return {
      command,
      cwd,
      timeout_ms: 20000,
    };
  }

  return {
    command: ["bash", "-lc", command],
    timeout_ms: 20000,
  };
}

function extractOutputText(body, callId) {
  function extractText(value) {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = extractText(item);
        if (typeof text === "string" && text) {
          return text;
        }
      }
      return null;
    }
    if (!value || typeof value !== "object") {
      return null;
    }
    if (typeof value.text === "string" && value.text) {
      return value.text;
    }
    if (typeof value.content === "string" && value.content) {
      return value.content;
    }
    if (typeof value.stdout === "string" && value.stdout) {
      return value.stdout;
    }
    if (typeof value.rawOutput === "string" && value.rawOutput) {
      return value.rawOutput;
    }
    for (const key of ["content", "output", "result", "items"]) {
      const text = extractText(value[key]);
      if (typeof text === "string" && text) {
        return text;
      }
    }
    return null;
  }

  const input = Array.isArray(body.input) ? body.input : [];
  const item = input.find(
    (entry) =>
      (entry.type === "function_call_output" ||
        entry.type === "custom_tool_call_output") &&
      entry.call_id === callId
  );
  if (!item) {
    return null;
  }
  return extractText(item.output);
}

function extractAgentIdFromSpawnOutput(body, callId) {
  const outputText = extractOutputText(body, callId);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    return typeof parsed?.agent_id === "string" && parsed.agent_id
      ? parsed.agent_id
      : null;
  } catch {
    return null;
  }
}

function extractCompletedMessageFromWaitOutput(body, callId) {
  const outputText = extractOutputText(body, callId);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    const statuses = parsed?.status;
    if (!statuses || typeof statuses !== "object") {
      return null;
    }
    for (const value of Object.values(statuses)) {
      if (value && typeof value === "object") {
        if (typeof value.Completed === "string") {
          return value.Completed;
        }
        if (typeof value.completed === "string") {
          return value.completed;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function computeExpectedChildOutput(taskPrompt) {
  if (taskPrompt.includes("multiline")) {
    return [
      `completed:${taskPrompt}`,
      "Finding 1",
      "Finding 2",
      "Finding 3",
    ].join("\n");
  }
  return `completed:${taskPrompt}`;
}

function startDirectSkillProvider({
  userRequest,
  expectedNeedles = [],
  shellCommands,
  cwd = PROJECT_ROOT,
}) {
  const requests = [];
  const errors = [];
  const shellCallIdPrefix = "direct-shell";

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mock-model", object: "model" },
              { id: "gpt-5.3-codex", object: "model" },
            ],
          })
        );
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      try {
        const responseIndex = requests.filter(
          (entry) => entry.method === "POST"
        ).length;
        const bodyText = JSON.stringify(body);
        let events;

        if (responseIndex === 1) {
          assert.ok(
            bodyText.includes(userRequest),
            "skill turn should receive the raw user request"
          );
          for (const needle of expectedNeedles) {
            assert.ok(bodyText.includes(needle), `skill turn should include ${needle}`);
          }
        }

        if (responseIndex <= shellCommands.length) {
          const shellTool = chooseShellTool(body);
          events = [
            eventCreated(`resp-direct-${responseIndex}`),
            eventFunctionCall(
              `${shellCallIdPrefix}-${responseIndex}`,
              shellTool,
              buildShellArgs(shellTool, shellCommands[responseIndex - 1], cwd)
            ),
            eventCompleted(`resp-direct-${responseIndex}`),
          ];
        } else if (responseIndex === shellCommands.length + 1) {
          const output = extractOutputText(
            body,
            `${shellCallIdPrefix}-${shellCommands.length}`
          );
          assert.ok(
            typeof output === "string" && output.trim(),
            "provider should receive shell output before the final assistant reply"
          );
          events = [
            eventCreated("resp-direct-final"),
            eventAssistantMessage("msg-direct-final", output.trimEnd()),
            eventCompleted("resp-direct-final"),
          ];
        } else {
          throw new Error(`Unexpected POST /v1/responses call #${responseIndex}`);
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(formatSse(events));
      } catch (error) {
        errors.push({
          method: req.method,
          url: req.url,
          message: error instanceof Error ? error.message : String(error),
          body,
        });
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.stack || error.message : String(error));
      }
    });
  });

  return {
    errors,
    requests,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function setupGitWorkspace(workspaceDir) {
  function run(args) {
    const result = spawnSync("git", args, {
      cwd: workspaceDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  run(["init", "--initial-branch=main"]);
  run(["config", "user.name", "Codex Test"]);
  run(["config", "user.email", "codex@example.com"]);
  fs.writeFileSync(
    path.join(workspaceDir, "app.js"),
    "export function value() {\n  return 1;\n}\n",
    "utf8"
  );
  run(["add", "app.js"]);
  run(["commit", "-m", "initial"]);
}

const WORKER_EXECUTION_CONTRACT =
  "Start exactly one companion process in non-interactive foreground mode.\n" +
  "If the shell tool yields, wait on the same returned process until exit; never relaunch the command.\n" +
  "Use the host's permitted execution defaults and only supported tool parameters.\n";

function getToolSchema(body, name) {
  const tool = findTool(body, name)?.tool;
  return tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? {};
}

function buildSpawnArgs(body, message) {
  const schema = getToolSchema(body, "spawn_agent");
  const properties = schema.properties ?? {};
  const args = { message };
  if (properties.fork_turns) args.fork_turns = "none";
  else if (properties.fork_context) args.fork_context = false;
  if (schema.required?.includes("task_name")) args.task_name = "claude_forwarder";
  return args;
}

function buildWaitArgs(body, toolName, agentId) {
  const properties = getToolSchema(body, toolName).properties ?? {};
  const args = { timeout_ms: 1000 };
  if (properties.targets) args.targets = [agentId];
  else if (properties.ids) args.ids = [agentId];
  return args;
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function startMockProvider({
  taskPrompt,
  userRequest,
  mode = "builtin-default",
  skillTitle = "Claude Code Rescue",
  expectedParentNeedles = [],
  taskCommand: taskCommandOverride = null,
  expectedChildNeedles = [],
  expectedFinalOutput = null,
  notificationMessage = null,
  spawnMessage = null,
  childPromptChecks = "rescue",
  forceYield = false,
}) {
  const requests = [];
  const errors = [];
  const phases = [];
  const spawnCallId = "spawn-1";
  const taskCommand = taskCommandOverride ??
    `node ${shellQuote(COMPANION_SCRIPT)} task --fresh ${shellQuote(taskPrompt)}`;
  const workerMessage = spawnMessage ??
    "You are a transient forwarding worker for Claude Code rescue.\n" +
    "Run exactly one shell command.\n" + WORKER_EXECUTION_CONTRACT +
    "Return only that command's stdout text exactly. Ignore stderr progress chatter such as [cc] lines.\n" +
    "Preserve only the final stdout-equivalent result text; do not trim, normalize, add punctuation, or add commentary.\n" +
    "Do not inspect the repository, read files, grep, do the task directly, or reinterpret routing flags.\n" +
    "Copy the resolved rescue task text byte-for-byte into the exact command below.\n" +
    "Do not drop prefixes like completed: or strip a leading slash command.\n" +
    "If the companion reports missing setup or auth, return that output unchanged.\n\n" + taskCommand;
  const finalOutput = notificationMessage ?? expectedFinalOutput ?? computeExpectedChildOutput(taskPrompt);
  let childProcessCallId = "shell-1";
  let childStarted = false;
  let childCompleted = false;
  let parentStarted = false;
  let agentId = null;
  let sequence = 0;
  let providerFailure = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      try {
        sequence += 1;
        if (providerFailure) throw new Error(providerFailure);
        assert.ok(sequence <= 30, `mock delegation exceeded 30 requests; phases=${JSON.stringify(phases)}`);
        const responseId = `resp-${sequence}`;
        const bodyText = JSON.stringify(body);
        // Parent and child requests may interleave. Identify the actor from its
        // user message, never from a global request count.
        const isParent = (body.input ?? []).some((item) => {
          const content = typeof item.content === "string" ? item.content :
            (item.content ?? []).map((part) => part.text ?? "").join("\n");
          return item.role === "user" && content.includes(userRequest);
        });
        let output;
        if (isParent && !parentStarted) {
          parentStarted = true;
          phases.push("parent-init");
          assert.ok(bodyText.includes(skillTitle), `${skillTitle} must reach the parent`);
          for (const needle of expectedParentNeedles) {
            assert.ok(bodyText.includes(needle), `parent turn should include ${needle}`);
          }
          assert.ok(findTool(body, "spawn_agent"), "parent must expose spawn_agent for this built-in-path test");
          if (mode === "builtin-alias") assert.ok(bodyText.includes("--builtin-agent"));
          output = eventFunctionCall(spawnCallId, "spawn_agent", buildSpawnArgs(body, workerMessage), getToolNamespace(body, "spawn_agent"));
        } else if (isParent) {
          agentId ??= extractAgentIdFromSpawnOutput(body, spawnCallId);
          if (childCompleted) {
            phases.push("parent-final");
            output = eventAssistantMessage(`msg-${sequence}`, finalOutput.trimEnd());
          } else {
            phases.push("parent-wait");
            const waitTool = findTool(body, "wait_agent") ? "wait_agent" : "wait";
            assert.ok(findTool(body, waitTool), "foreground parent must have a wait tool");
            assert.ok(agentId, "spawn result must identify the child to wait for");
            output = eventFunctionCall(`wait-${sequence}`, waitTool, buildWaitArgs(body, waitTool, agentId), getToolNamespace(body, waitTool));
          }
        } else if (!childStarted) {
          childStarted = true;
          phases.push("child-shell");
          assert.ok(bodyText.includes(COMPANION_SCRIPT), "child must receive the resolved companion path");
          assert.ok(bodyText.includes("host's permitted execution defaults"), "child must honor host execution permissions");
          assert.ok(bodyText.includes("never relaunch the command"), "child must continue the same yielded process");
          if (childPromptChecks === "rescue") {
            assert.ok(bodyText.includes("transient forwarding worker for Claude Code rescue"));
            assert.ok(bodyText.includes("Copy the resolved rescue task text byte-for-byte"));
          }
          for (const needle of expectedChildNeedles) {
            assert.ok(bodyText.includes(needle), `child turn should include ${needle}`);
          }
          assert.doesNotMatch(taskCommand, /claude-companion\.mjs["']?\s+task\s+--(?:background|wait)\b/);
          const shellTool = chooseShellTool(body);
          output = eventFunctionCall(childProcessCallId, shellTool, {
            ...buildShellArgs(shellTool, taskCommand),
            ...(forceYield && shellTool === "exec_command" ? { yield_time_ms: 1 } : {}),
          }, getToolNamespace(body, shellTool));
        } else {
          const processOutput = extractOutputText(body, childProcessCallId) ?? "";
          const runningSession = processOutput.match(/(?:Process running with session ID|session_id["\s:]*)\s*(\d+)/i)?.[1];
          if (runningSession) {
            phases.push("child-wait-process");
            assert.ok(findTool(body, "write_stdin"), "yielded exec must expose write_stdin");
            childProcessCallId = `process-wait-${sequence}`;
            output = eventFunctionCall(childProcessCallId, "write_stdin", {
              session_id: Number(runningSession), chars: "", yield_time_ms: 1000, max_output_tokens: 12000,
            }, getToolNamespace(body, "write_stdin"));
          } else {
            assert.match(processOutput, /Process exited with code 0|"(?:exit_code|exitCode)"\s*:\s*0/, `companion must exit successfully before a result is returned: ${processOutput}`);
            if (!notificationMessage) {
              assert.ok(processOutput.includes(finalOutput.trim()), "final response must come from actual companion stdout");
            }
            childCompleted = true;
            phases.push("child-final");
            output = eventAssistantMessage(`msg-${sequence}`, finalOutput.trimEnd());
          }
        }
        const events = [eventCreated(responseId), output, eventCompleted(responseId)];
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.end("data: [DONE]\n\n");
      } catch (error) {
        providerFailure = error instanceof Error ? error.message : String(error);
        if (errors.length === 0) errors.push({ message: providerFailure, phases: [...phases] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [eventCreated("resp-error"), eventAssistantMessage("msg-error", `MOCK_PROVIDER_ERROR: ${providerFailure}`), eventCompleted("resp-error")]) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      }
    });
  });
  return {
    errors, phases, requests,
    listen() { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

function runCodexExec(testEnv, prompt, options = {}) {
  const cwd = options.cwd ?? PROJECT_ROOT;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-m",
    "mock-model",
    "--enable",
    "multi_agent",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "-C",
    cwd,
    "-o",
    testEnv.outputFile,
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      env: testEnv.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`codex exec timed out\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
      );
    }, 60000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function readClaudeInvocations(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Codex rescue-skill E2E", () => {
  it("routes $cc:rescue through the built-in rescue subagent, the companion task runtime, and the fake Claude CLI", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e foreground delay=1000";
    const userRequest = "$cc:rescue --wait say hello from codex e2e";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-default",
      forceYield: true,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      assert.ok(
        fs.existsSync(testEnv.outputFile),
        [
          "expected codex exec to write the last message file",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${taskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.length === 1,
        `expected exactly one Claude process; calls=${claudeInvocations.length}; phases=${JSON.stringify(provider.phases)}`
      );
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt === taskPrompt),
        `expected fake Claude invocation for prompt ${taskPrompt}`
      );

      assert.equal(provider.phases.filter((phase) => phase === "child-shell").length, 1);
      assert.ok(provider.phases.includes("child-wait-process"), "forced yield must exercise process continuation");
      assert.ok(provider.phases.includes("child-final"));
      assert.ok(provider.phases.indexOf("child-final") < provider.phases.indexOf("parent-final"));

    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("defaults $cc:rescue without execution flags to the foreground companion path", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e default-foreground delay=10";
    const userRequest = "$cc:rescue say hello from codex e2e without flags";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-default",
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      assert.ok(
        fs.existsSync(testEnv.outputFile),
        [
          "expected codex exec to write the last message file",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${taskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt === taskPrompt),
        `expected fake Claude invocation for prompt ${taskPrompt}`
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("keeps background rescue completion as a steering message instead of inlining the raw result", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const reservedJobId = reserveJob(testEnv, "task");
    const taskPrompt = "codex-rescue-e2e background-notify delay=10";
    const userRequest = "$cc:rescue --background say hello from codex e2e in background";
    const notificationMessage = `Background Claude Code rescue finished. Open it with $cc:result ${reservedJobId}.`;
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-default",
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} task --fresh --cwd ${JSON.stringify(PROJECT_ROOT)} --job-id ${JSON.stringify(reservedJobId)} --view-state defer ${JSON.stringify(taskPrompt)}`,
      expectedChildNeedles: ["--view-state defer", "--job-id", reservedJobId],
      expectedParentNeedles: ["shared host execution contract"],
      notificationMessage,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "background rescue codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, notificationMessage);
      assert.notEqual(finalMessage, `completed:${taskPrompt}`);
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("passes through a multiline rescue result exactly in the foreground path", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e multiline delay=10";
    const userRequest = "$cc:rescue --wait /simplify";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-default",
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, computeExpectedChildOutput(taskPrompt));
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("accepts the legacy --builtin-agent alias without any extra rescue-agent install path", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const taskPrompt = "codex-rescue-e2e builtin-agent delay=10";
    const userRequest = "$cc:rescue --builtin-agent --wait say hello from codex e2e";
    const provider = startMockProvider({
      taskPrompt,
      userRequest,
      mode: "builtin-alias",
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, buildRescuePrompt(userRequest));

      assert.equal(
        execResult.status,
        0,
        [
          "codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      assert.ok(
        fs.existsSync(testEnv.outputFile),
        [
          "expected codex exec to write the last message file",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${taskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt === taskPrompt),
        `expected fake Claude invocation for prompt ${taskPrompt}`
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("can resume a built-in rescue run with a delta follow-up", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const initialTaskPrompt = "codex-rescue-e2e builtin-agent initial delay=10";
    const initialRequest = "$cc:rescue --builtin-agent --wait say hello from codex e2e";
    let provider = startMockProvider({
      taskPrompt: initialTaskPrompt,
      userRequest: initialRequest,
      mode: "builtin-alias",
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const initialResult = await runCodexExec(
        testEnv,
        buildRescuePrompt(initialRequest)
      );
      assert.equal(
        initialResult.status,
        0,
        [
          "initial built-in rescue failed",
          `stdout:\n${initialResult.stdout}`,
          `stderr:\n${initialResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const firstFinalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(firstFinalMessage, `completed:${initialTaskPrompt}`);
    } finally {
      await provider.close();
    }

    const followupTaskPrompt = "only fix the quoting issue and keep everything else";
    const followupRequest =
      "$cc:rescue --builtin-agent --wait --resume only fix the quoting issue and keep everything else";
    provider = startMockProvider({
      taskPrompt: followupTaskPrompt,
      userRequest: followupRequest,
      mode: "builtin-alias",
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} task --resume ${JSON.stringify(followupTaskPrompt)}`,
      expectedChildNeedles: ["task --resume"],
    });
    testEnv.providerPort = await provider.listen();
    fs.rmSync(path.join(testEnv.codexHome, "config.toml"), { force: true });
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const followupResult = await runCodexExec(
        testEnv,
        buildRescuePrompt(followupRequest)
      );

      assert.equal(
        followupResult.status,
        0,
        [
          "resume built-in rescue failed",
          `stdout:\n${followupResult.stdout}`,
          `stderr:\n${followupResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, `completed:${followupTaskPrompt}`);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some(
          (entry) =>
            entry.prompt === followupTaskPrompt && entry.sessionId === "stub-session"
        ),
        "expected follow-up built-in rescue to resume the stub Claude session with the delta prompt"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  for (const scenario of [
    {
      name: "a slash-style rescue request",
      taskPrompt: "/simplify make the output compact",
      userRequest: "$cc:rescue --builtin-agent --wait /simplify make the output compact",
    },
    {
      name: "a quoted literal rescue request",
      taskPrompt: "return exactly 'foo \"bar\" baz'",
      userRequest: "$cc:rescue --builtin-agent --wait return exactly 'foo \"bar\" baz'",
    },
    {
      name: "a multiline rescue request",
      taskPrompt: "output exactly:\nline 1\n\nline 2\nline 3",
      userRequest:
        "$cc:rescue --builtin-agent --wait output exactly:\nline 1\n\nline 2\nline 3",
    },
    {
      name: "a mixed-language rescue request",
      taskPrompt: "한국어 2줄 + English 1 line 형식으로 답해줘",
      userRequest:
        "$cc:rescue --builtin-agent --wait 한국어 2줄 + English 1 line 형식으로 답해줘",
    },
    {
      name: "a follow-up style rescue request",
      taskPrompt: "keep going from the last fix and make it clean",
      userRequest:
        "$cc:rescue --builtin-agent --wait keep going from the last fix and make it clean",
    },
    {
      name: "an ambiguous rescue request",
      taskPrompt: "take care of the thing from earlier",
      userRequest:
        "$cc:rescue --builtin-agent --wait take care of the thing from earlier",
    },
  ]) {
    it(`preserves ${scenario.name} through the experimental built-in path`, async (t) => {
      if (!codexAvailable()) {
        t.skip("codex CLI is not available in this environment");
        return;
      }

      const testEnv = createEnvironment();
      const provider = startMockProvider({
        taskPrompt: scenario.taskPrompt,
        userRequest: scenario.userRequest,
        mode: "builtin-alias",
      });
      testEnv.providerPort = await provider.listen();
      writeConfigToml(testEnv, testEnv.providerPort);

      try {
        const execResult = await runCodexExec(
          testEnv,
          buildRescuePrompt(scenario.userRequest)
        );

        assert.equal(
          execResult.status,
          0,
          [
            "codex exec failed",
            `stdout:\n${execResult.stdout}`,
            `stderr:\n${execResult.stderr}`,
            `provider requests: ${provider.requests.length}`,
            `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
          ].join("\n\n")
        );

        const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
        assert.equal(finalMessage, `completed:${scenario.taskPrompt}`);

        const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
        if (scenario.taskPrompt.includes("\n")) {
          assert.ok(
            claudeInvocations.length >= 1,
            "expected at least one fake Claude invocation for multiline prompt coverage"
          );
        } else {
          assert.ok(
            claudeInvocations.some((entry) => entry.prompt === scenario.taskPrompt),
            `expected fake Claude invocation for prompt ${JSON.stringify(scenario.taskPrompt)}`
          );
        }
      } finally {
        await provider.close();
        cleanupEnvironment(testEnv);
      }
    });
  }
});

describe("Codex direct-skill E2E", () => {
  it("uses the installed plugin review skill without running $cc:setup first", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "installed-review-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 4;\n}\n",
      "utf8"
    );

    const pluginRoot = installPlugin(testEnv);

    const userRequest = "$cc:review --wait --scope working-tree --model haiku";
    const companionScript = path.join(pluginRoot, "scripts", "claude-companion.mjs");
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Review"],
      shellCommands: [
        `node ${JSON.stringify(companionScript)} review --view-state on-success --scope working-tree --model haiku`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(testEnv, userRequest, { cwd: workspaceDir });

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Claude Code Review/);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some(
          (entry) => entry.args.includes("--model") && entry.args.includes("haiku")
        ),
        "installed plugin review should forward the requested model alias to Claude without running setup first"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:review --wait through the companion review command with forwarded scope and model", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "review-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 2;\n}\n",
      "utf8"
    );

    const userRequest = "$cc:review --wait --scope working-tree --model haiku";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Review"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} review --view-state on-success --scope working-tree --model haiku`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:review", REVIEW_SKILL_PATH, userRequest),
        { cwd: workspaceDir }
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Claude Code Review/);
      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.args.includes("--model") && entry.args.includes("haiku")),
        "review e2e should forward the requested model alias to Claude"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:review --background through the built-in path with notification steering", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "review-background-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 5;\n}\n",
      "utf8"
    );

    const reservedJobId = reserveJob(testEnv, "review", workspaceDir);
    const ownerSessionId = "parent-review-session";
    const userRequest = "$cc:review --background --scope working-tree --model haiku";
    const notificationMessage =
      `Background Claude Code review finished. Open it with $cc:result ${reservedJobId}.`;
    const provider = startMockProvider({
      taskPrompt: "background review raw output should not surface",
      userRequest,
      skillTitle: "Claude Code Review",
      expectedParentNeedles: [
        "background-routing-context --kind review --json",
        "--owner-session-id <owner-session-id>",
        "Never satisfy background review by running the companion command itself with shell backgrounding",
        "Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.",
      ],
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} review --view-state defer --scope working-tree --model haiku --cwd ${JSON.stringify(workspaceDir)} --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)}`,
      expectedChildNeedles: [
        "--view-state defer",
        "--job-id",
        reservedJobId,
        "--owner-session-id",
        ownerSessionId,
        notificationMessage,
      ],
      notificationMessage,
      childPromptChecks: "generic",
      spawnMessage:
        "You are a pure forwarder for a background Claude Code review job.\n" +
        "Do not inspect the repo, do not review anything yourself, and do not add commentary.\n" +
        "Run exactly one shell command and capture only the stdout-equivalent final result text from that command, ignoring stderr progress chatter like [cc] lines.\n" +
              WORKER_EXECUTION_CONTRACT +
        "If the command succeeds, let native completion delivery carry this final steering message: " +
        JSON.stringify(notificationMessage) + "\n" +
        "Use that same sentence as your own final assistant message.\n" +
        "If the command fails, return only the command stdout if any, otherwise a terse failure note.\n\n" +
        `node ${JSON.stringify(COMPANION_SCRIPT)} review --view-state defer --scope working-tree --model haiku --cwd ${JSON.stringify(workspaceDir)} --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)}`,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:review", REVIEW_SKILL_PATH, userRequest),
        { cwd: workspaceDir }
      );

      assert.equal(
        execResult.status,
        0,
        [
          "background review codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, notificationMessage);
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:adversarial-review --wait through the companion command with focus text", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "adversarial-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 3;\n}\n",
      "utf8"
    );

    const userRequest =
      "$cc:adversarial-review --wait --scope working-tree --model haiku focus on race conditions";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Adversarial Review"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state on-success --scope working-tree --model haiku focus on race conditions`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt(
          "cc:adversarial-review",
          ADVERSARIAL_REVIEW_SKILL_PATH,
          userRequest
        ),
        { cwd: workspaceDir }
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Adversarial Review/);
      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt.includes("focus on race conditions")),
        "adversarial review e2e should preserve the user focus text in the Claude prompt"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("injects review-versus-adversarial focus routing guidance when both skills are available", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "focus-routing-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 7;\n}\n",
      "utf8"
    );

    const userRequest =
      "$cc:review --wait --scope working-tree --model haiku focus on race conditions";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: [
        "`$cc:review` does not accept custom focus text",
        "Unlike `$cc:review`, this skill accepts custom focus text after the flags",
        "keep the delegated Claude part on `$cc:review`",
      ],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state on-success --scope working-tree --model haiku focus on race conditions`,
      ],
      cwd: workspaceDir,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildMultiSkillPrompt(
          [
            { name: "cc:review", path: REVIEW_SKILL_PATH },
            { name: "cc:adversarial-review", path: ADVERSARIAL_REVIEW_SKILL_PATH },
          ],
          userRequest
        ),
        { cwd: workspaceDir }
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Adversarial Review/);

      const claudeInvocations = readClaudeInvocations(testEnv.claudeLogFile);
      assert.ok(
        claudeInvocations.some((entry) => entry.prompt.includes("focus on race conditions")),
        "focus-routing e2e should preserve the user focus text when the adversarial path is selected"
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:adversarial-review --background through the built-in path with notification steering", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const workspaceDir = path.join(testEnv.rootDir, "adversarial-background-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    fs.writeFileSync(
      path.join(workspaceDir, "app.js"),
      "export function value() {\n  return 6;\n}\n",
      "utf8"
    );

    const reservedJobId = reserveJob(testEnv, "review", workspaceDir);
    const ownerSessionId = "parent-adversarial-session";
    const userRequest =
      "$cc:adversarial-review --background --scope working-tree --model haiku focus on race conditions";
    const notificationMessage =
      `Background Claude Code adversarial review finished. Open it with $cc:result ${reservedJobId}.`;
    const provider = startMockProvider({
      taskPrompt: "background adversarial review raw output should not surface",
      userRequest,
      skillTitle: "Claude Code Adversarial Review",
      expectedParentNeedles: [
        "background-routing-context --kind review --json",
        "--owner-session-id <owner-session-id>",
        "Never satisfy background adversarial review by running the companion command itself with shell backgrounding",
        "Background Claude Code adversarial review finished. Open it with $cc:result <reserved-job-id>.",
      ],
      taskCommand:
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state defer --scope working-tree --model haiku --cwd ${JSON.stringify(workspaceDir)} --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)} focus on race conditions`,
      expectedChildNeedles: [
        "--view-state defer",
        "--job-id",
        reservedJobId,
        "--owner-session-id",
        ownerSessionId,
        notificationMessage,
        "focus on race conditions",
      ],
      notificationMessage,
      childPromptChecks: "generic",
      spawnMessage:
        "You are a pure forwarder for a background Claude Code adversarial review job.\n" +
        "Do not inspect the repo, do not review anything yourself, and do not add commentary.\n" +
        "Run exactly one shell command and capture only the stdout-equivalent final result text from that command, ignoring stderr progress chatter like [cc] lines.\n" +
              WORKER_EXECUTION_CONTRACT +
        "If the command succeeds, let native completion delivery carry this final steering message: " +
        JSON.stringify(notificationMessage) + "\n" +
        "Use that same sentence as your own final assistant message.\n" +
        "If the command fails, return only the command stdout if any, otherwise a terse failure note.\n\n" +
        `node ${JSON.stringify(COMPANION_SCRIPT)} adversarial-review --view-state defer --scope working-tree --model haiku --cwd ${JSON.stringify(workspaceDir)} --job-id ${JSON.stringify(reservedJobId)} --owner-session-id ${JSON.stringify(ownerSessionId)} focus on race conditions`,
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt(
          "cc:adversarial-review",
          ADVERSARIAL_REVIEW_SKILL_PATH,
          userRequest
        ),
        { cwd: workspaceDir }
      );

      assert.equal(
        execResult.status,
        0,
        [
          "background adversarial review codex exec failed",
          `stdout:\n${execResult.stdout}`,
          `stderr:\n${execResult.stderr}`,
          `provider requests: ${provider.requests.length}`,
          `provider errors: ${JSON.stringify(provider.errors, null, 2)}`,
        ].join("\n\n")
      );

      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8").trim();
      assert.equal(finalMessage, notificationMessage);
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("routes $cc:setup --enable-review-gate through the json probe then final setup command", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const userRequest = "$cc:setup --enable-review-gate";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Setup"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --json --enable-review-gate`,
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --enable-review-gate`,
      ],
    });
    testEnv.providerPort = await provider.listen();
    installHooks(testEnv);
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:setup", SETUP_SKILL_PATH, userRequest)
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /review gate: enabled/i);
      assert.match(
        finalMessage,
        new RegExp(`Enabled the turn-end review gate for ${PROJECT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("repairs native plugin hook feature gates during $cc:setup", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const userRequest = "$cc:setup";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Setup"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --json`,
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup`,
      ],
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:setup", SETUP_SKILL_PATH, userRequest)
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Status: ready/i);
      assert.match(finalMessage, /hooks: native Codex plugin hooks enabled/i);

      const hooksFile = path.join(testEnv.codexHome, "hooks.json");
      const config = fs.readFileSync(path.join(testEnv.codexHome, "config.toml"), "utf8");
      assert.ok(!fs.existsSync(hooksFile), "setup should not install global hooks");
      assert.match(config, /hooks = true/);
      assert.doesNotMatch(config, /plugin_hooks/);
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });

  it("repairs native plugin hooks during $cc:setup --enable-review-gate", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    const userRequest = "$cc:setup --enable-review-gate";
    const provider = startDirectSkillProvider({
      userRequest,
      expectedNeedles: ["Claude Code Setup"],
      shellCommands: [
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --json --enable-review-gate`,
        `node ${JSON.stringify(COMPANION_SCRIPT)} setup --enable-review-gate`,
      ],
    });
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const execResult = await runCodexExec(
        testEnv,
        buildSkillPrompt("cc:setup", SETUP_SKILL_PATH, userRequest)
      );

      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);
      const finalMessage = fs.readFileSync(testEnv.outputFile, "utf8");
      assert.match(finalMessage, /Status: ready/i);
      assert.match(finalMessage, /hooks: native Codex plugin hooks enabled/i);
      assert.match(finalMessage, /review gate: enabled/i);
      assert.match(finalMessage, /Enabled the turn-end review gate/i);

      const hooksFile = path.join(testEnv.codexHome, "hooks.json");
      const config = fs.readFileSync(path.join(testEnv.codexHome, "config.toml"), "utf8");
      assert.ok(!fs.existsSync(hooksFile));
      assert.match(config, /hooks = true/);
      assert.doesNotMatch(config, /plugin_hooks/);
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });
});

function startPlainProvider() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        formatSse([
          eventCreated("resp-plain"),
          eventAssistantMessage("msg-plain", "ok"),
          eventCompleted("resp-plain"),
        ])
      );
    });
  });

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// Codex trusts hooks one by one: a hook only runs once its current hash is
// recorded under [hooks.state]. Mirrors upstream's own hooks/list ->
// config/batchWrite recipe so the dispatch assertions below exercise real hooks.
function trustPluginHooks(testEnv, cwd) {
  const clientPath = path.join(PROJECT_ROOT, "scripts", "lib", "codex-app-server.mjs");
  const script = `
import { callCodexAppServer } from ${JSON.stringify(clientPath)};
const cwd = ${JSON.stringify(cwd)};
const listed = await callCodexAppServer({ cwd, method: "hooks/list", params: { cwds: [cwd] } });
const hooks = (listed.data ?? []).flatMap((entry) => entry.hooks ?? []);
const state = Object.fromEntries(hooks.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
if (Object.keys(state).length > 0) {
  await callCodexAppServer({
    cwd,
    method: "config/batchWrite",
    params: {
      edits: [{ keyPath: "hooks.state", value: state, mergeStrategy: "upsert" }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  });
}
process.stdout.write(JSON.stringify(hooks.map((hook) => hook.eventName)));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: testEnv.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function readDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function pluginStateWorkspaceDirs(testEnv) {
  const dataRoot = path.join(testEnv.codexHome, "plugins", "data");
  return readDirNames(dataRoot).flatMap((pluginDir) => {
    const stateRoot = path.join(dataRoot, pluginDir, "state");
    return readDirNames(stateRoot).map((workspace) => path.join(stateRoot, workspace));
  });
}

describe("native hook dispatch", () => {
  it("runs the installed plugin's SessionEnd hook and drops the session marker", async (t) => {
    if (!codexAvailable()) {
      t.skip("codex CLI is not available in this environment");
      return;
    }

    const testEnv = createEnvironment();
    // A nested session id would make SessionStart skip the marker this asserts on.
    delete testEnv.env.CLAUDE_COMPANION_SESSION_ID;
    const workspaceDir = path.join(testEnv.rootDir, "session-end-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    setupGitWorkspace(workspaceDir);
    installPlugin(testEnv);

    const provider = startPlainProvider();
    testEnv.providerPort = await provider.listen();
    writeConfigToml(testEnv, testEnv.providerPort);

    try {
      const trusted = trustPluginHooks(testEnv, workspaceDir);
      assert.ok(
        trusted.includes("sessionEnd"),
        `Codex should discover the plugin SessionEnd hook, saw ${JSON.stringify(trusted)}`
      );

      const execResult = await runCodexExec(testEnv, "Reply with exactly: ok", {
        cwd: workspaceDir,
      });
      assert.equal(execResult.status, 0, execResult.stderr || execResult.stdout);

      const stateDirs = pluginStateWorkspaceDirs(testEnv);
      // SessionStart creates the workspace state dir and writes the marker;
      // only SessionEnd removes the marker, so an existing dir without one
      // proves Codex dispatched SessionEnd to this plugin.
      assert.ok(
        stateDirs.length > 0,
        "session hooks should have created a workspace state directory"
      );
      for (const stateDir of stateDirs) {
        assert.ok(
          !fs.existsSync(path.join(stateDir, "current-session.json")),
          `SessionEnd should have cleared the session marker in ${stateDir}`
        );
      }
    } finally {
      await provider.close();
      cleanupEnvironment(testEnv);
    }
  });
});


describe("mock-provider host schema adaptation", () => {
  it("uses app task_name/fork_turns and inherits model and effort", () => {
    const body = { tools: [{ type: "namespace", name: "collaboration", tools: [{
      name: "spawn_agent", parameters: { required: ["task_name", "message"], properties: {
        task_name: { type: "string" }, message: { type: "string" }, fork_turns: { type: "string" },
      } },
    }] }] };
    assert.deepEqual(buildSpawnArgs(body, "forward"), {
      message: "forward", task_name: "claude_forwarder", fork_turns: "none",
    });
    assert.equal(getToolNamespace(body, "spawn_agent"), "collaboration");
  });

  it("uses CLI fork_context only when advertised", () => {
    const body = { tools: [{ name: "spawn_agent", parameters: { properties: {
      message: { type: "string" }, fork_context: { type: "boolean" },
    } } }] };
    assert.deepEqual(buildSpawnArgs(body, "forward"), { message: "forward", fork_context: false });
    assert.deepEqual(buildSpawnArgs({ tools: [{ name: "spawn_agent" }] }, "forward"), { message: "forward" });
  });

  it("does not send CLI wait targets to an app mailbox wait", () => {
    const body = { tools: [{ name: "wait_agent", parameters: { properties: { timeout_ms: {} } } }] };
    assert.deepEqual(buildWaitArgs(body, "wait_agent", "synthetic-agent"), { timeout_ms: 1000 });
  });
});
