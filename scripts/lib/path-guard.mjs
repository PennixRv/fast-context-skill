import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FastContextError } from "./public-error.mjs";

const VIRTUAL_ROOT = "/codebase";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_WALK_FILES = 512;
const MAX_TREE_ENTRIES = 300;
const MAX_TREE_DEPTH = 4;

const HARD_DIRECTORY_NAMES = new Set([
  ".cache",
  ".codegraph",
  ".codex",
  ".git",
  ".ssh",
  ".trellis",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "generated",
  "logs",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor",
]);

const SENSITIVE_NAME_PATTERN = /(?:api[-_]?key|credential|password|secret|token)/i;
const GENERATED_NAME_PATTERN = /(?:\.log|\.map|\.tmp|\.generated)$/i;
const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function realPath(value) {
  const resolver = realpathSync.native || realpathSync;
  return resolver(value);
}

function pathError(code) {
  return new FastContextError(code);
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    if (".+^${}()|[]\\".includes(character)) {
      expression += `\\${character}`;
      continue;
    }
    expression += character;
  }
  return new RegExp(`${expression}$`);
}

function validateExtraPattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw pathError("FC_PATH_INVALID");
  }
  if (pattern.includes("\\") || pattern.startsWith("!") || isAbsolute(pattern)) {
    throw pathError("FC_PATH_INVALID");
  }
  if (DRIVE_PATH_PATTERN.test(pattern)) {
    throw pathError("FC_PATH_INVALID");
  }
  const parts = pattern.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw pathError("FC_PATH_INVALID");
  }
  return { pattern, matcher: globToRegExp(pattern) };
}

function isContained(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export class PathGuard {
  /**
   * @param {string} projectRoot
   * @param {string[]} [extraDenyPatterns]
   */
  constructor(projectRoot, extraDenyPatterns = []) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw pathError("FC_PROJECT_INVALID");
    }

    let canonicalRoot;
    try {
      canonicalRoot = realPath(projectRoot);
      if (!statSync(canonicalRoot).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw pathError("FC_PROJECT_INVALID");
    }

    this.root = canonicalRoot;
    this.extraDenyPatterns = extraDenyPatterns.map(validateExtraPattern);
  }

  /**
   * @param {string} value
   * @param {{ allowRoot?: boolean }} [options]
   * @returns {string}
   */
  normalizeVirtualPath(value, { allowRoot = false } = {}) {
    if (typeof value !== "string" || value.length === 0) {
      if (allowRoot && value === VIRTUAL_ROOT) return "";
      throw pathError("FC_PATH_INVALID");
    }
    if (value === VIRTUAL_ROOT) {
      if (allowRoot) return "";
      throw pathError("FC_PATH_INVALID");
    }

    let relativePath = value;
    if (value.startsWith(`${VIRTUAL_ROOT}/`)) {
      relativePath = value.slice(VIRTUAL_ROOT.length + 1);
    } else if (value.startsWith(`${VIRTUAL_ROOT}\\`)) {
      throw pathError("FC_PATH_INVALID");
    }

    if (
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      /[\u0000-\u001f\u007f]/.test(relativePath) ||
      isAbsolute(relativePath) ||
      DRIVE_PATH_PATTERN.test(relativePath)
    ) {
      throw pathError("FC_PATH_INVALID");
    }

    const parts = relativePath.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
      throw pathError("FC_PATH_INVALID");
    }
    return parts.join("/");
  }

  /**
   * @param {string} relativePath
   * @returns {boolean}
   */
  isDeniedRelative(relativePath) {
    const normalized = toPosix(relativePath);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.some((part) => HARD_DIRECTORY_NAMES.has(part))) return true;

    const filename = parts.at(-1) || "";
    if (
      parts.some((part) => part === ".env" || part.startsWith(".env.") || SENSITIVE_NAME_PATTERN.test(part)) ||
      filename.endsWith(".pem") ||
      filename.endsWith(".key") ||
      filename.startsWith("id_") ||
      filename === ".npmrc" ||
      filename === ".netrc" ||
      GENERATED_NAME_PATTERN.test(filename)
    ) {
      return true;
    }

    return this.extraDenyPatterns.some(({ matcher }) => matcher.test(normalized));
  }

  /**
   * @param {string} value
   * @param {{ kind?: "file"|"directory"|"any", allowRoot?: boolean }} [options]
   */
  resolveExisting(value, { kind = "any", allowRoot = false } = {}) {
    const relativePath = this.normalizeVirtualPath(value, { allowRoot });
    if (relativePath && this.isDeniedRelative(relativePath)) {
      throw pathError("FC_PATH_DENIED");
    }

    const lexicalPath = resolve(this.root, relativePath);
    let canonicalPath;
    try {
      canonicalPath = realPath(lexicalPath);
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }

    if (!isContained(this.root, canonicalPath)) {
      throw pathError("FC_PATH_DENIED");
    }

    const canonicalRelative = toPosix(relative(this.root, canonicalPath));
    if (canonicalRelative && this.isDeniedRelative(canonicalRelative)) {
      throw pathError("FC_PATH_DENIED");
    }

    let stats;
    try {
      stats = statSync(canonicalPath);
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }
    if (
      (kind === "file" && !stats.isFile()) ||
      (kind === "directory" && !stats.isDirectory()) ||
      (!stats.isFile() && !stats.isDirectory())
    ) {
      throw pathError("FC_PATH_UNAVAILABLE");
    }

    return {
      absolutePath: canonicalPath,
      relativePath: canonicalRelative,
      type: stats.isDirectory() ? "directory" : "file",
    };
  }

  toVirtualPath(relativePath) {
    return relativePath ? `${VIRTUAL_ROOT}/${relativePath}` : VIRTUAL_ROOT;
  }

  listDirectory(value) {
    const directory = this.resolveExisting(value, { kind: "directory", allowRoot: true });
    const entries = [];
    let names;
    try {
      names = readdirSync(directory.absolutePath).sort();
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }

    for (const name of names) {
      const childRelative = directory.relativePath ? `${directory.relativePath}/${name}` : name;
      if (this.isDeniedRelative(childRelative)) continue;
      const childVirtual = this.toVirtualPath(childRelative);
      try {
        if (lstatSync(resolve(directory.absolutePath, name)).isSymbolicLink()) continue;
        const child = this.resolveExisting(childVirtual);
        entries.push({ name, relativePath: child.relativePath, type: child.type });
      } catch (error) {
        if (error?.code === "FC_PATH_DENIED" || error?.code === "FC_PATH_UNAVAILABLE") continue;
        throw error;
      }
    }
    return entries;
  }

  walkFiles(value, limit = MAX_WALK_FILES) {
    const start = this.resolveExisting(value, { allowRoot: true });
    const files = [];
    const visit = (entry) => {
      if (files.length >= limit) return;
      if (entry.type === "file") {
        files.push(entry);
        return;
      }
      for (const child of this.listDirectory(this.toVirtualPath(entry.relativePath))) {
        if (files.length >= limit) return;
        visit(child);
      }
    };
    visit(start);
    return files;
  }

  regularFiles(value, limit = MAX_WALK_FILES) {
    return this.walkFiles(value, limit).map((entry) => ({
      absolutePath: this.resolveExisting(this.toVirtualPath(entry.relativePath), { kind: "file" }).absolutePath,
      relativePath: entry.relativePath,
    }));
  }

  readText(value, startLine = 1, endLine = 80) {
    const file = this.resolveExisting(value, { kind: "file" });
    let stats;
    try {
      stats = statSync(file.absolutePath);
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }
    if (stats.size > MAX_FILE_BYTES) throw pathError("FC_OUTPUT_LIMIT");

    let content;
    try {
      content = readFileSync(file.absolutePath, "utf8");
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }
    const safeStart = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
    const safeEnd = Number.isInteger(endLine) && endLine >= safeStart
      ? Math.min(endLine, safeStart + 79)
      : safeStart + 79;
    const lines = content.split("\n").slice(safeStart - 1, safeEnd);
    return lines
      .map((line, index) => `${safeStart + index}:${line.slice(0, 240)}`)
      .join("\n") || "(empty file)";
  }

  tree(value = VIRTUAL_ROOT, levels = 2) {
    const depthLimit = Math.max(0, Math.min(MAX_TREE_DEPTH, Number(levels) || 0));
    const start = this.resolveExisting(value, { kind: "directory", allowRoot: true });
    const lines = [this.toVirtualPath(start.relativePath)];
    let count = 0;

    const visit = (entry, depth, prefix) => {
      if (depth > depthLimit || count >= MAX_TREE_ENTRIES) return;
      for (const child of this.listDirectory(this.toVirtualPath(entry.relativePath))) {
        if (count >= MAX_TREE_ENTRIES) return;
        count += 1;
        const marker = child.type === "directory" ? "/" : "";
        lines.push(`${prefix}- ${child.name}${marker}`);
        if (child.type === "directory") {
          visit(child, depth + 1, `${prefix}  `);
        }
      }
    };

    visit(start, 1, "");
    if (count >= MAX_TREE_ENTRIES) lines.push("- (tree truncated)");
    return lines.join("\n");
  }

  glob(value, pattern, typeFilter = "all") {
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.includes("\\") ||
      pattern.startsWith("!") ||
      isAbsolute(pattern) ||
      DRIVE_PATH_PATTERN.test(pattern) ||
      pattern.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !["all", "file", "directory"].includes(typeFilter)
    ) {
      throw pathError("FC_PATH_INVALID");
    }
    const base = this.resolveExisting(value, { kind: "directory", allowRoot: true });
    const matcher = globToRegExp(pattern.replace(/^\/+/, ""));
    const matches = [];
    const visit = (entry) => {
      if (matches.length >= 100) return;
      if (entry.relativePath !== base.relativePath) {
        const fromBase = base.relativePath
          ? entry.relativePath.slice(`${base.relativePath}/`.length)
          : entry.relativePath;
        const typeMatches = typeFilter === "all" || entry.type === typeFilter;
        if (typeMatches && matcher.test(fromBase)) {
          matches.push(this.toVirtualPath(entry.relativePath));
        }
      }
      if (entry.type !== "directory") return;
      for (const child of this.listDirectory(this.toVirtualPath(entry.relativePath))) {
        visit(child);
        if (matches.length >= 100) return;
      }
    };
    visit(base);
    return matches.join("\n") || "(no matches)";
  }

  buildRepoMap() {
    return this.tree(VIRTUAL_ROOT, 2);
  }
}

export const PATH_GUARD_LIMITS = Object.freeze({
  MAX_FILE_BYTES,
  MAX_WALK_FILES,
  MAX_TREE_ENTRIES,
});
