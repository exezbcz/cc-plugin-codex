#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

console.error(
  [
    "Register this checkout through Codex plugin-creator in your personal marketplace.",
    "Then run: node scripts/installer-cli.mjs install",
    "Codex owns the installed cache; setup --check verifies it without changing configuration.",
  ].join("\n")
);
process.exit(1);
