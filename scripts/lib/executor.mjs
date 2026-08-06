import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { FastContextError } from "./public-error.mjs";

const MAX_COMMANDS = 4;
const MAX_RG_PATTERN_LENGTH = 240;
const MAX_RG_OUTPUT_BYTES = 512 * 1024;

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

function parseRgOutput(output, files) {
  const text = String(output || "");
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const file = files.find((candidate) => line.startsWith(`${candidate.absolutePath}:`));
    if (!file) continue;
    const rest = line.slice(file.absolutePath.length + 1);
    const match = rest.match(/^(\d+):(.*)$/s);
    if (!match) continue;
    rows.push(`/codebase/${file.relativePath}:${match[1]}:${match[2].slice(0, 240)}`);
    if (rows.length >= 50) break;
  }
  return rows.join("\n") || "(no matches)";
}

export class ToolExecutor {
  /**
   * @param {import("./path-guard.mjs").PathGuard} guard
   * @param {{ executeFileSync?: Function, rgBinary?: string }} [options]
   */
  constructor(guard, options = {}) {
    this.guard = guard;
    this.executeFileSync = options.executeFileSync || execFileSync;
    this.rgBinary = options.rgBinary || defaultRgBinary();
    this.collectedRgPatterns = [];
  }

  rg(pattern, value) {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_RG_PATTERN_LENGTH) {
      throw new FastContextError("FC_PATH_INVALID");
    }
    const files = this.guard.regularFiles(value);
    if (!files.length) return "(no matches)";
    if (!isAbsolute(this.rgBinary)) throw new FastContextError("FC_TOOL_UNAVAILABLE");

    this.collectedRgPatterns.push(pattern.slice(0, MAX_RG_PATTERN_LENGTH));
    const args = [
      "--no-config",
      "--no-ignore",
      "--no-follow",
      "--no-heading",
      "--line-number",
      "--color",
      "never",
      "--max-count",
      "50",
      "--regexp",
      pattern,
      "--",
      ...files.map((file) => file.absolutePath),
    ];
    try {
      const stdout = this.executeFileSync(this.rgBinary, args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: MAX_RG_OUTPUT_BYTES,
        env: {
          LANG: "C",
          LC_ALL: "C",
          RIPGREP_CONFIG_PATH: "",
        },
      });
      return parseRgOutput(stdout, files);
    } catch (error) {
      if (error?.status === 1) return "(no matches)";
      throw new FastContextError(safeToolError(error));
    }
  }

  readfile(file, startLine = 1, endLine = 80) {
    return this.guard.readText(file, startLine, endLine);
  }

  tree(value, levels = 2) {
    return this.guard.tree(value, levels);
  }

  ls(value, longFormat = false, allFiles = false) {
    const entries = this.guard.listDirectory(value);
    const visible = allFiles ? entries : entries.filter((entry) => !entry.name.startsWith("."));
    if (!longFormat) return visible.map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join("\n") || "(empty)";
    return visible.map((entry) => `${entry.type === "directory" ? "d" : "-"} ${entry.name}`).join("\n") || "(empty)";
  }

  glob(pattern, value, typeFilter = "all") {
    return this.guard.glob(value, pattern, typeFilter);
  }

  execCommand(command) {
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

  async execCommandAsync(command) {
    return this.execCommand(command);
  }

  execToolCall(args) {
    if (!args || typeof args !== "object") throw new FastContextError("FC_PROTOCOL_INVALID");
    const keys = Object.keys(args)
      .filter((key) => /^command[1-4]$/.test(key))
      .sort()
      .slice(0, MAX_COMMANDS);
    if (!keys.length) throw new FastContextError("FC_PROTOCOL_INVALID");
    return keys
      .map((key) => {
        try {
          return `<${key}_result>\n${this.execCommand(args[key])}\n</${key}_result>`;
        } catch (error) {
          return `<${key}_result>\n${safeToolError(error)}\n</${key}_result>`;
        }
      })
      .join("");
  }

  async execToolCallAsync(args) {
    return this.execToolCall(args);
  }
}

export const EXECUTOR_LIMITS = Object.freeze({
  MAX_COMMANDS,
  MAX_RG_PATTERN_LENGTH,
  MAX_RG_OUTPUT_BYTES,
});
