#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Modified for explicit marketplace ownership and local fork installation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { callCodexAppServer } from "./lib/codex-app-server.mjs";
import { ensureCodexWritableRoots, ensureNativePluginHooksEnabled } from "./lib/codex-config.mjs";
import { resolveCodexHome, resolveMarketplacePluginDataRoot } from "./lib/codex-paths.mjs";
import { pluginIdForMarketplace, PLUGIN_NAME } from "./lib/plugin-identity.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validateName(name) {
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Marketplace must have a valid nonempty name.");
  }
  return name;
}

function readCatalog(marketplacePath, expectedName) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  } catch {
    throw new Error("No readable marketplace catalog. Register this source with Codex plugin-creator, or set CC_PLUGIN_CODEX_MARKETPLACE_PATH to its marketplace.json.");
  }
  const marketplaceName = validateName(catalog.name);
  if (expectedName && marketplaceName !== expectedName) {
    throw new Error("Marketplace name does not match CC_PLUGIN_CODEX_MARKETPLACE_NAME.");
  }
  const entries = Array.isArray(catalog.plugins)
    ? catalog.plugins.filter((entry) => entry?.name === PLUGIN_NAME)
    : [];
  if (entries.length !== 1) {
    throw new Error("Marketplace must contain exactly one cc entry.");
  }
  return { marketplacePath, marketplaceName };
}

async function resolveMarketplace(command) {
  const source = process.env.CC_PLUGIN_CODEX_MARKETPLACE_SOURCE?.trim();
  const configuredPath = process.env.CC_PLUGIN_CODEX_MARKETPLACE_PATH?.trim();
  const name = process.env.CC_PLUGIN_CODEX_MARKETPLACE_NAME?.trim();
  if (name) validateName(name);
  if (source && configuredPath) {
    throw new Error("Choose CC_PLUGIN_CODEX_MARKETPLACE_SOURCE or CC_PLUGIN_CODEX_MARKETPLACE_PATH, not both.");
  }
  // Uninstall targets one explicit identity and never adds/refreshes a source.
  if (command === "uninstall" && name) return { marketplaceName: name };
  if (source && command === "uninstall") {
    throw new Error("Set CC_PLUGIN_CODEX_MARKETPLACE_NAME to the exact installation to uninstall.");
  }
  if (source) {
    const params = { source };
    const refName = process.env.CC_PLUGIN_CODEX_MARKETPLACE_REF?.trim();
    if (refName) params.refName = refName;
    const sparsePaths = (process.env.CC_PLUGIN_CODEX_MARKETPLACE_SPARSE_PATHS ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean);
    if (sparsePaths.length) params.sparsePaths = sparsePaths;
    const added = await callCodexAppServer({ cwd: PACKAGE_ROOT, method: "marketplace/add", params });
    return readCatalog(path.join(added.installedRoot, ".agents", "plugins", "marketplace.json"), name);
  }
  return readCatalog(
    configuredPath ? path.resolve(configuredPath) : path.join(os.homedir(), ".agents", "plugins", "marketplace.json"),
    name,
  );
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!["install", "update", "uninstall"].includes(command) || extra.length) {
    throw new Error("Usage: node scripts/installer-cli.mjs <install|update|uninstall>");
  }
  const marketplace = await resolveMarketplace(command);
  const pluginId = pluginIdForMarketplace(marketplace.marketplaceName);
  if (command === "uninstall") {
    await callCodexAppServer({
      cwd: PACKAGE_ROOT,
      method: "plugin/uninstall",
      params: { pluginId, forceRemoteSync: false },
    });
    console.log(`Uninstalled ${pluginId}. Saved results and source registration are retained.`);
    return;
  }
  await callCodexAppServer({
    cwd: path.dirname(marketplace.marketplacePath),
    method: "plugin/install",
    params: { marketplacePath: marketplace.marketplacePath, pluginName: PLUGIN_NAME, forceRemoteSync: false },
  });

  // Configure only the selected installation. Never sweep legacy cc entries,
  // other marketplace caches, credentials, or another installation's roots.
  const configFile = path.join(resolveCodexHome(), "config.toml");
  const config = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const hooks = ensureNativePluginHooksEnabled(config);
  if (hooks.changed) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, hooks.content, { mode: 0o600 });
  }
  const rootsChanged = await ensureCodexWritableRoots(PACKAGE_ROOT, [resolveMarketplacePluginDataRoot(marketplace.marketplaceName)]);
  console.log(`Installed ${pluginId} from the selected marketplace into the Codex plugin cache.`);
  if (hooks.changed || rootsChanged) console.log("Restart Codex to load the updated plugin configuration.");
  console.log("Run $cc:setup --check in a fresh task to verify readiness.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Plugin installation failed.");
  process.exitCode = 1;
});
