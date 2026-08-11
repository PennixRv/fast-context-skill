import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RESOURCE_LIMITS, ResourceBudget } from "./path-guard.mjs";
import { FastContextError } from "./public-error.mjs";

const MAX_COMMANDS = 4;
const MAX_RG_PATTERN_LENGTH = 240;
const MAX_RG_OUTPUT_BYTES = RESOURCE_LIMITS.MAX_OUTPUT_BYTES;
const MAX_RG_FILES_PER_BATCH = 128;
const PROCESS_KILL_GRACE_MS = 100;

function defaultRgBinary() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\ripgrep\\rg.exe"]
    : ["/usr/bin/rg", "/bin/rg", "/opt/homebrew/bin/rg", "/usr/local/bin/rg"];
  return candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate)) || null;
}

function safeToolError(error) {
  if (error instanceof FastContextError) return error.code;
  return "FC_TOOL_UNAVAILABLE";
}

function toolError(code = "FC_TOOL_UNAVAILABLE") {
  return new FastContextError(code);
}

/**
 * Spawn one fixed executable without a shell and settle only after `close`.
 */
export function runBoundedProcess(binary, args, options = {}) {
  const {
    signal,
    maxOutputBytes = MAX_RG_OUTPUT_BYTES,
    onOutputBytes = () => true,
    onSpawn = () => {},
    spawnImpl = spawn,
    killGraceMs = PROCESS_KILL_GRACE_MS,
    ...spawnOptions
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, {
        ...spawnOptions,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      reject(toolError());
      return;
    }

    let closed = false;
    let forceTimer = null;
    let spawnFailed = false;
    let aborted = false;
    let outputExceeded = false;
    let outputBytes = 0;
    const chunks = [];

    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const terminate = () => {
      if (closed) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close/error handlers still determine the final result.
      }
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          if (closed) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have closed between the checks.
          }
        }, killGraceMs);
        forceTimer.unref?.();
      }
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };

    child.stdout?.on("data", (chunk) => {
      if (outputExceeded) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let accepted = false;
      try {
        accepted = outputBytes <= maxOutputBytes - value.length && onOutputBytes(value.length);
      } catch {
        aborted = true;
        terminate();
        return;
      }
      if (!accepted) {
        outputExceeded = true;
        terminate();
        return;
      }
      outputBytes += value.length;
      chunks.push(value);
    });
    child.once("error", () => {
      spawnFailed = true;
      if (!child.pid) {
        closed = true;
        cleanup();
        reject(toolError());
      }
    });
    child.once("close", (code) => {
      if (closed) return;
      closed = true;
      cleanup();
      if (outputExceeded) {
        reject(toolError("FC_OUTPUT_LIMIT"));
        return;
      }
      if (aborted || spawnFailed) {
        reject(toolError());
        return;
      }
      resolve({ status: Number.isInteger(code) ? code : 2, stdout: Buffer.concat(chunks, outputBytes).toString("utf8") });
    });

    try {
      onSpawn(child.pid);
    } catch {
      aborted = true;
      terminate();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function parseRgOutput(output, files, budget) {
  const byAbsolutePath = new Map(files.map((file) => [file.absolutePath, file]));
  const rows = [];
  let truncated = false;
  for (const line of String(output || "").split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw toolError();
    }
    if (event?.type !== "match") continue;
    const path = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const lineText = event.data?.lines?.text;
    if (typeof path !== "string" || !Number.isSafeInteger(lineNumber) || lineNumber < 1 || typeof lineText !== "string") {
      throw toolError();
    }
    const file = byAbsolutePath.get(path);
    if (!file) continue;
    if (!budget.tryConsume("matches", 1, "match_limit")) {
      truncated = true;
      break;
    }
    rows.push(`/codebase/${file.relativePath}:${lineNumber}:${lineText.replace(/[\r\n]+$/, "").slice(0, 240)}`);
  }
  return { rows, truncated };
}

function commandResult(status, output, budget, continuation = null, reason = null, code = null) {
  return {
    status,
    output,
    visited: budget.snapshot().visited,
    continuation,
    reason,
    ...(code ? { code } : {}),
  };
}

export class ToolExecutor {
  /**
   * @param {import("./path-guard.mjs").PathGuard} guard
   * @param {{
   *   budget?: ResourceBudget,
   *   rgBinary?: string,
   *   runProcess?: typeof runBoundedProcess,
   *   onCommandResult?: (event: { command_index: string, command_type: string, status: string, reason: string | null, code: string | null }) => void,
   * }} [options]
   */
  constructor(guard, options = {}) {
    this.guard = guard;
    this.budget = options.budget || new ResourceBudget();
    this.rgBinary = options.rgBinary || defaultRgBinary();
    this.runProcess = options.runProcess || runBoundedProcess;
    this.onCommandResult = options.onCommandResult;
    this.collectedRgPatterns = [];
    this.hadTruncation = false;
    this.hadFailure = false;
    this.continuations = [];
  }

  remember(result) {
    if (result.status === "truncated") this.hadTruncation = true;
    if (result.status === "failure") this.hadFailure = true;
    if (result.continuation) this.continuations.push(result.continuation);
    return result;
  }

  async rg(pattern, value) {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_RG_PATTERN_LENGTH) {
      throw new FastContextError("FC_PATH_INVALID");
    }
    if (!isAbsolute(this.rgBinary)) throw toolError();

    const enumeration = await this.guard.regularFiles(value, this.budget);
    const rows = [];
    let truncated = enumeration.status === "truncated";
    this.collectedRgPatterns.push(pattern.slice(0, MAX_RG_PATTERN_LENGTH));

    for (let index = 0; index < enumeration.files.length; index += MAX_RG_FILES_PER_BATCH) {
      this.budget.assertActive();
      const files = enumeration.files.slice(index, index + MAX_RG_FILES_PER_BATCH);
      const args = [
        "--no-config",
        "--no-ignore",
        "--no-follow",
        "--json",
        "--max-count",
        "50",
        "--regexp",
        pattern,
        "--",
        ...files.map((file) => file.absolutePath),
      ];
      const remainingOutputBytes = Math.max(
        1,
        Math.min(
          MAX_RG_OUTPUT_BYTES,
          this.budget.limits.MAX_OUTPUT_BYTES - this.budget.usage.outputBytes,
        ),
      );
      let result;
      try {
        result = await this.runProcess(this.rgBinary, args, {
          cwd: this.guard.root,
          env: {
            LANG: "C",
            LC_ALL: "C",
            RIPGREP_CONFIG_PATH: "",
          },
          signal: this.budget.signal,
          maxOutputBytes: remainingOutputBytes,
          onOutputBytes: (bytes) => this.budget.tryConsume("outputBytes", bytes, "output_limit"),
        });
      } catch (error) {
        if (error instanceof FastContextError) throw error;
        throw toolError();
      }
      if (result.status === 1) continue;
      if (result.status !== 0) throw toolError();
      const parsed = parseRgOutput(result.stdout, files, this.budget);
      rows.push(...parsed.rows);
      if (parsed.truncated) {
        truncated = true;
        break;
      }
    }

    if (truncated) this.budget.markTruncated(enumeration.reason || "search_truncated");
    const output = rows.join("\n") || (truncated ? "(no matches in visited files)" : "(no matches)");
    return this.remember(commandResult(
      truncated ? "truncated" : "complete",
      output,
      this.budget,
      enumeration.continuation,
      truncated ? (enumeration.reason || "search_truncated") : null,
    ));
  }

  async readfile(file, startLine = 1, endLine = 80) {
    return this.remember(await this.guard.readText(file, startLine, endLine, this.budget));
  }

  async tree(value, levels = 2) {
    return this.remember(await this.guard.tree(value, levels, this.budget));
  }

  async ls(value, longFormat = false, allFiles = false) {
    const result = await this.guard.listDirectory(value, this.budget);
    const visible = allFiles
      ? result.entries
      : result.entries.filter((entry) => !entry.name.startsWith("."));
    const output = longFormat
      ? visible.map((entry) => `${entry.type === "directory" ? "d" : "-"} ${entry.name}`).join("\n") || "(empty)"
      : visible.map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join("\n") || "(empty)";
    if (!this.budget.tryConsume("outputBytes", Buffer.byteLength(output), "output_limit")) {
      return this.remember(commandResult("truncated", "(output budget exhausted)", this.budget, result.continuation, "output_limit"));
    }
    return this.remember(commandResult(result.status, output, this.budget, result.continuation, result.reason));
  }

  async glob(pattern, value, typeFilter = "all") {
    return this.remember(await this.guard.glob(value, pattern, typeFilter, this.budget));
  }

  async execCommand(command) {
    if (!command || typeof command !== "object") throw new FastContextError("FC_PROTOCOL_INVALID");
    switch (command.type) {
      case "rg":
        return this.rg(command.pattern, command.path);
      case "readfile":
        return this.readfile(command.file, command.start_line, command.end_line);
      case "tree":
        return this.tree(command.path, command.levels);
      case "ls":
        return this.ls(command.path, command.long_format, command.all);
      case "glob":
        return this.glob(command.pattern, command.path, command.type_filter);
      default:
        throw new FastContextError("FC_PROTOCOL_INVALID");
    }
  }

  async execToolCall(args) {
    if (!args || typeof args !== "object") throw new FastContextError("FC_PROTOCOL_INVALID");
    const keys = Object.keys(args)
      .filter((key) => /^command[1-4]$/.test(key))
      .sort()
      .slice(0, MAX_COMMANDS);
    if (!keys.length) throw new FastContextError("FC_PROTOCOL_INVALID");

    const rendered = [];
    for (const key of keys) {
      let result;
      try {
        result = await this.execCommand(args[key]);
      } catch (error) {
        if (this.budget.signal.aborted || error?.code === "FC_REMOTE_UNAVAILABLE") {
          throw new FastContextError("FC_REMOTE_UNAVAILABLE");
        }
        const code = safeToolError(error);
        this.hadFailure = true;
        this.budget.markTruncated("local_tool_failure");
        result = commandResult("failure", "", this.budget, null, "local_tool_failure", code);
      }
      rendered.push(`<${key}_result>\n${JSON.stringify(result)}\n</${key}_result>`);
      if (typeof this.onCommandResult === "function") {
        try {
          this.onCommandResult(Object.freeze({
            command_index: key,
            command_type: typeof args[key]?.type === "string" ? args[key].type : "invalid",
            status: result.status,
            reason: result.reason || null,
            code: result.code || null,
          }));
        } catch {
          // Optional observation must not alter bounded local execution.
        }
      }
    }
    return rendered.join("");
  }

  coverage() {
    return {
      truncated: this.hadTruncation || this.hadFailure || this.budget.truncated,
      failed: this.hadFailure,
      continuation: this.continuations.at(-1) || null,
    };
  }
}

export const EXECUTOR_LIMITS = Object.freeze({
  MAX_COMMANDS,
  MAX_RG_PATTERN_LENGTH,
  MAX_RG_OUTPUT_BYTES,
  MAX_RG_FILES_PER_BATCH,
  PROCESS_KILL_GRACE_MS,
});
