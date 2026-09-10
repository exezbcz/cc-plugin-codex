/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

/**
 * Get stable process identity for PID reuse detection.
 * Returns a string that is immutable for the process lifetime.
 */
export function getProcessIdentity(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    const runCommandCheckedImpl = options.runCommandCheckedImpl ?? runCommandChecked;
    // exec() keeps the PID and birth time but changes comm (for example when a
    // shell wrapper replaces itself with Claude). Only birth time is identity.
    const row = runCommandCheckedImpl('ps', ['-o', 'lstart=', '-p', String(pid)]);
    return normalizeDarwinProcessIdentity(row.stdout.trim());
  } else {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    const fields = stat.slice(closeParen + 2).split(' ');
    return fields[19]; // starttime field
  }
}

function normalizeDarwinProcessIdentity(identity) {
  if (typeof identity !== "string") return identity;
  // Older jobs stored `lstart,comm`. Accept those records without treating the
  // executable name as identity; still compare the entire process birth time.
  const birthTime = identity.match(
    /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s|$)/,
  );
  return birthTime ? birthTime[1].replace(/\s+/g, " ") : identity;
}

export function validateProcessIdentity(pid, expectedIdentity, options = {}) {
  const identityImpl = options.identityImpl ?? getProcessIdentity;
  try {
    const actualIdentity = identityImpl(pid);
    if ((options.platform ?? process.platform) === "darwin") {
      return normalizeDarwinProcessIdentity(actualIdentity) ===
        normalizeDarwinProcessIdentity(expectedIdentity);
    }
    return actualIdentity === expectedIdentity;
  } catch (error) {
    // A denied probe (sandboxed `ps`, unreadable /proc entry) means the identity
    // cannot be established, not that the process is gone. Fall back to the
    // zero-signal liveness probe, which still reports ESRCH for a dead PID.
    // PID-reuse detection is only given up when identity is unknowable at all.
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return isProcessAlive(pid, options);
    }
    return false;
  }
}

export function isProcessAlive(pid, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
