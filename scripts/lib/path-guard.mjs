import {
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import {
  lstat as lstatAsync,
  open,
  opendir,
  readFile,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FastContextError } from "./public-error.mjs";

const VIRTUAL_ROOT = "/codebase";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_CANDIDATE_RANGE_LINES = 200;
const MAX_ELAPSED_MS = 30_000;
const MAX_VISITED_ENTRIES = 4_096;
const MAX_VISITED_DIRECTORIES = 512;
const MAX_WALK_DEPTH = 16;
const MAX_WALK_FILES = 2_048;
const MAX_MATCHES = 200;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_GLOB_RESULTS = 100;
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
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
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

export const RESOURCE_LIMITS = Object.freeze({
  MAX_ELAPSED_MS,
  MAX_VISITED_ENTRIES,
  MAX_VISITED_DIRECTORIES,
  MAX_WALK_DEPTH,
  MAX_WALK_FILES,
  MAX_MATCHES,
  MAX_OUTPUT_BYTES,
});

export const RESOURCE_BUDGET_ABORT = Object.freeze({
  DEADLINE: "fast-context-resource-deadline",
});

export class ResourceBudget {
  /**
   * @param {{
   *   timeoutMs?: number,
   *   signal?: AbortSignal,
   *   limits?: Partial<typeof RESOURCE_LIMITS>,
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.now = options.now || (() => performance.now());
    this.limits = Object.freeze({ ...RESOURCE_LIMITS, ...(options.limits || {}) });
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw pathError("FC_PROTOCOL_INVALID");
    }
    const requestedTimeout = options.timeoutMs ?? this.limits.MAX_ELAPSED_MS;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw pathError("FC_REMOTE_UNAVAILABLE");
    }
    const elapsedLimit = Math.min(Math.floor(requestedTimeout), this.limits.MAX_ELAPSED_MS);
    this.startedAt = this.now();
    this.deadline = this.startedAt + elapsedLimit;
    this.usage = {
      entries: 0,
      directories: 0,
      files: 0,
      matches: 0,
      outputBytes: 0,
    };
    this.truncationReasons = new Set();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.externalSignal = options.signal;
    this.onExternalAbort = () => this.controller.abort(this.externalSignal?.reason);
    if (this.externalSignal) {
      if (typeof this.externalSignal.addEventListener !== "function") {
        throw pathError("FC_PROTOCOL_INVALID");
      }
      if (this.externalSignal.aborted) this.controller.abort(this.externalSignal.reason);
      else this.externalSignal.addEventListener("abort", this.onExternalAbort, { once: true });
    }
    this.timer = setTimeout(() => this.controller.abort(RESOURCE_BUDGET_ABORT.DEADLINE), elapsedLimit);
    this.timer.unref?.();
  }

  assertActive() {
    if (this.signal.aborted || this.now() >= this.deadline) {
      if (this.now() >= this.deadline) this.controller.abort(RESOURCE_BUDGET_ABORT.DEADLINE);
      throw pathError("FC_REMOTE_UNAVAILABLE");
    }
  }

  remainingMs() {
    this.assertActive();
    return Math.max(1, Math.ceil(this.deadline - this.now()));
  }

  markTruncated(reason) {
    this.truncationReasons.add(reason);
  }

  tryConsume(kind, amount = 1, reason = `${kind}_limit`) {
    this.assertActive();
    if (!Number.isSafeInteger(amount) || amount < 0 || !(kind in this.usage)) {
      throw pathError("FC_PROTOCOL_INVALID");
    }
    const limitKey = {
      entries: "MAX_VISITED_ENTRIES",
      directories: "MAX_VISITED_DIRECTORIES",
      files: "MAX_WALK_FILES",
      matches: "MAX_MATCHES",
      outputBytes: "MAX_OUTPUT_BYTES",
    }[kind];
    if (this.usage[kind] > this.limits[limitKey] - amount) {
      this.markTruncated(reason);
      return false;
    }
    this.usage[kind] += amount;
    return true;
  }

  allowsDepth(depth) {
    this.assertActive();
    if (!Number.isSafeInteger(depth) || depth < 0) throw pathError("FC_PROTOCOL_INVALID");
    if (depth > this.limits.MAX_WALK_DEPTH) {
      this.markTruncated("depth_limit");
      return false;
    }
    return true;
  }

  get truncated() {
    return this.truncationReasons.size > 0;
  }

  snapshot() {
    return {
      visited: { ...this.usage },
      elapsed_ms: Math.max(0, Math.round(this.now() - this.startedAt)),
      remaining_ms: Math.max(0, Math.ceil(this.deadline - this.now())),
      reasons: [...this.truncationReasons].sort(),
    };
  }

  dispose() {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener?.("abort", this.onExternalAbort);
  }
}

function typedResult(status, payload, budget, continuation = null, reason = null) {
  return {
    status,
    ...payload,
    visited: budget.snapshot().visited,
    continuation,
    reason,
  };
}

function sameFileVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
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
      stats,
    };
  }

  async resolveExistingAsync(value, { kind = "any", allowRoot = false } = {}) {
    const relativePath = this.normalizeVirtualPath(value, { allowRoot });
    if (relativePath && this.isDeniedRelative(relativePath)) {
      throw pathError("FC_PATH_DENIED");
    }

    const lexicalPath = resolve(this.root, relativePath);
    let canonicalPath;
    try {
      canonicalPath = await realpathAsync(lexicalPath);
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }
    if (!isContained(this.root, canonicalPath)) throw pathError("FC_PATH_DENIED");

    const canonicalRelative = toPosix(relative(this.root, canonicalPath));
    if (canonicalRelative && this.isDeniedRelative(canonicalRelative)) {
      throw pathError("FC_PATH_DENIED");
    }

    let stats;
    try {
      stats = await statAsync(canonicalPath);
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
      stats,
    };
  }

  toVirtualPath(relativePath) {
    return relativePath ? `${VIRTUAL_ROOT}/${relativePath}` : VIRTUAL_ROOT;
  }

  async listDirectory(value, budget) {
    const directory = await this.resolveExistingAsync(value, { kind: "directory", allowRoot: true });
    const entries = [];
    if (!budget.tryConsume("directories", 1, "directory_limit")) {
      return typedResult("truncated", { entries }, budget, {
        directory: this.toVirtualPath(directory.relativePath),
        next_after: null,
      }, "directory_limit");
    }

    let handle;
    try {
      handle = await opendir(directory.absolutePath);
    } catch {
      throw pathError("FC_PATH_UNAVAILABLE");
    }

    let truncated = false;
    let lastName = null;
    try {
      for await (const dirent of handle) {
        budget.assertActive();
        if (!budget.tryConsume("entries", 1, "entry_limit")) {
          truncated = true;
          break;
        }
        lastName = dirent.name;
        const childRelative = directory.relativePath
          ? `${directory.relativePath}/${dirent.name}`
          : dirent.name;
        if (this.isDeniedRelative(childRelative)) continue;
        const childVirtual = this.toVirtualPath(childRelative);
        try {
          if ((await lstatAsync(resolve(directory.absolutePath, dirent.name))).isSymbolicLink()) continue;
          const child = await this.resolveExistingAsync(childVirtual);
          entries.push({
            name: dirent.name,
            absolutePath: child.absolutePath,
            relativePath: child.relativePath,
            type: child.type,
            stats: child.stats,
          });
        } catch (error) {
          if (error?.code === "FC_PATH_DENIED" || error?.code === "FC_PATH_UNAVAILABLE") continue;
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof FastContextError) throw error;
      throw pathError("FC_PATH_UNAVAILABLE");
    } finally {
      try {
        await handle.close();
      } catch {
        // for-await closes a directory handle after complete iteration.
      }
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return typedResult(
      truncated ? "truncated" : "complete",
      { entries },
      budget,
      truncated ? {
        directory: this.toVirtualPath(directory.relativePath),
        next_after: lastName,
      } : null,
      truncated ? "entry_limit" : null,
    );
  }

  async walkEntries(value, budget) {
    const start = await this.resolveExistingAsync(value, { allowRoot: true });
    const entries = [];
    if (start.type === "file") {
      if (!budget.tryConsume("files", 1, "file_limit")) {
        return typedResult("truncated", { entries }, budget, {
          pending_directories: 0,
          next_path: this.toVirtualPath(start.relativePath),
        }, "file_limit");
      }
      entries.push(start);
      return typedResult("complete", { entries }, budget);
    }

    const queue = [{ entry: start, depth: 0 }];
    let lastPath = this.toVirtualPath(start.relativePath);
    while (queue.length > 0) {
      budget.assertActive();
      const current = queue.shift();
      if (!budget.allowsDepth(current.depth)) {
        return typedResult("truncated", { entries }, budget, {
          pending_directories: queue.length + 1,
          next_path: this.toVirtualPath(current.entry.relativePath),
        }, "depth_limit");
      }

      const listing = await this.listDirectory(
        this.toVirtualPath(current.entry.relativePath),
        budget,
      );
      for (const child of listing.entries) {
        lastPath = this.toVirtualPath(child.relativePath);
        entries.push(child);
        if (child.type === "file") {
          if (!budget.tryConsume("files", 1, "file_limit")) {
            entries.pop();
            return typedResult("truncated", { entries }, budget, {
              pending_directories: queue.length,
              next_path: lastPath,
            }, "file_limit");
          }
        } else if (budget.allowsDepth(current.depth + 1)) {
          queue.push({ entry: child, depth: current.depth + 1 });
        } else {
          return typedResult("truncated", { entries }, budget, {
            pending_directories: queue.length + 1,
            next_path: lastPath,
          }, "depth_limit");
        }
      }
      if (listing.status === "truncated") {
        return typedResult("truncated", { entries }, budget, {
          ...listing.continuation,
          pending_directories: queue.length,
        }, listing.reason);
      }
    }

    return typedResult("complete", { entries }, budget);
  }

  async walkFiles(value, budget) {
    const result = await this.walkEntries(value, budget);
    return {
      ...result,
      files: result.entries.filter((entry) => entry.type === "file"),
    };
  }

  async regularFiles(value, budget) {
    const result = await this.walkFiles(value, budget);
    return {
      status: result.status,
      files: result.files.map((entry) => ({
        absolutePath: entry.absolutePath,
        relativePath: entry.relativePath,
      })),
      visited: result.visited,
      continuation: result.continuation,
      reason: result.reason,
    };
  }

  async readText(value, startLine = 1, endLine = 80, budget) {
    const file = await this.resolveExistingAsync(value, { kind: "file" });
    if (!budget.tryConsume("files", 1, "file_limit")) {
      return typedResult("truncated", { output: "(file budget exhausted)" }, budget, {
        next_path: this.toVirtualPath(file.relativePath),
      }, "file_limit");
    }
    if (file.stats.size > MAX_FILE_BYTES) throw pathError("FC_OUTPUT_LIMIT");
    let content;
    try {
      content = await readFile(file.absolutePath, { encoding: "utf8", signal: budget.signal });
    } catch {
      if (budget.signal.aborted) throw pathError("FC_REMOTE_UNAVAILABLE");
      throw pathError("FC_PATH_UNAVAILABLE");
    }
    const safeStart = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
    const requestedEnd = Number.isInteger(endLine) && endLine >= safeStart
      ? endLine
      : safeStart + 79;
    const safeEnd = Math.min(requestedEnd, safeStart + 79);
    const lines = content.split("\n").slice(safeStart - 1, safeEnd);
    const output = lines
      .map((line, index) => `${safeStart + index}:${line.slice(0, 240)}`)
      .join("\n") || "(empty file)";
    const readRange = lines.length > 0
      ? { start_line: safeStart, end_line: safeStart + lines.length - 1 }
      : null;
    const truncated = requestedEnd > safeEnd;
    if (truncated) budget.markTruncated("line_limit");
    if (!budget.tryConsume("outputBytes", Buffer.byteLength(output), "output_limit")) {
      return typedResult("truncated", { output: "(output budget exhausted)" }, budget, null, "output_limit");
    }
    return typedResult(
      truncated ? "truncated" : "complete",
      { output, read_range: readRange },
      budget,
      null,
      truncated ? "line_limit" : null,
    );
  }

  async validateCandidateRange(value, startLine, endLine, budget) {
    budget.assertActive();
    if (
      !Number.isSafeInteger(startLine)
      || !Number.isSafeInteger(endLine)
      || startLine < 1
      || endLine < startLine
      || endLine - startLine + 1 > MAX_CANDIDATE_RANGE_LINES
    ) {
      return null;
    }

    const file = await this.resolveExistingAsync(value, { kind: "file" });
    if (!budget.tryConsume("files", 1, "file_limit")) return null;

    let handle;
    let before;
    let after;
    let content;
    try {
      handle = await open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      before = await handle.stat({ bigint: true });
      const pathBefore = await statAsync(file.absolutePath, { bigint: true });
      if (!sameFileVersion(before, pathBefore)) {
        budget.markTruncated("candidate_changed");
        return null;
      }
      if (before.size > BigInt(MAX_FILE_BYTES)) return null;
      content = await handle.readFile({ signal: budget.signal });
      after = await handle.stat({ bigint: true });
    } catch {
      if (budget.signal.aborted) throw pathError("FC_REMOTE_UNAVAILABLE");
      throw pathError("FC_PATH_UNAVAILABLE");
    } finally {
      try {
        await handle?.close();
      } catch {
        // Validation fails through the version checks; close errors are not public.
      }
    }

    budget.assertActive();
    if (!sameFileVersion(before, after)) {
      budget.markTruncated("candidate_changed");
      return null;
    }

    let current;
    try {
      current = await this.resolveExistingAsync(value, { kind: "file" });
      const pathAfter = await statAsync(current.absolutePath, { bigint: true });
      if (current.absolutePath !== file.absolutePath || !sameFileVersion(before, pathAfter)) {
        budget.markTruncated("candidate_changed");
        return null;
      }
    } catch {
      budget.markTruncated("candidate_changed");
      return null;
    }

    budget.assertActive();
    if (content.length === 0) return null;
    let newlineCount = 0;
    for (const byte of content) {
      if (byte === 0x0a) newlineCount += 1;
    }
    const lineCount = newlineCount + (content.at(-1) === 0x0a ? 0 : 1);
    if (startLine > lineCount || endLine > lineCount) return null;

    return {
      relativePath: current.relativePath,
      startLine,
      endLine,
      lineCount,
    };
  }

  async tree(value = VIRTUAL_ROOT, levels = 2, budget) {
    const depthLimit = Math.max(0, Math.min(MAX_TREE_DEPTH, Number(levels) || 0));
    const start = await this.resolveExistingAsync(value, { kind: "directory", allowRoot: true });
    const lines = [this.toVirtualPath(start.relativePath)];
    let count = 0;
    let truncated = false;
    let reason = null;
    let continuation = null;
    const queue = [{ entry: start, depth: 1, prefix: "" }];
    while (queue.length > 0 && !truncated) {
      const current = queue.shift();
      if (current.depth > depthLimit) continue;
      if (!budget.allowsDepth(current.depth - 1)) {
        truncated = true;
        reason = "depth_limit";
        continuation = {
          pending_directories: queue.length + 1,
          next_path: this.toVirtualPath(current.entry.relativePath),
        };
        break;
      }
      const listing = await this.listDirectory(this.toVirtualPath(current.entry.relativePath), budget);
      for (const child of listing.entries) {
        if (count >= MAX_TREE_ENTRIES) {
          truncated = true;
          reason = "tree_entry_limit";
          budget.markTruncated(reason);
          continuation = { pending_directories: queue.length, next_path: this.toVirtualPath(child.relativePath) };
          break;
        }
        count += 1;
        const marker = child.type === "directory" ? "/" : "";
        lines.push(`${current.prefix}- ${child.name}${marker}`);
        if (child.type === "directory" && current.depth < depthLimit) {
          queue.push({ entry: child, depth: current.depth + 1, prefix: `${current.prefix}  ` });
        }
      }
      if (listing.status === "truncated") {
        truncated = true;
        reason = listing.reason;
        continuation = { ...listing.continuation, pending_directories: queue.length };
      }
    }
    if (truncated) lines.push("- (tree truncated)");
    const output = lines.join("\n");
    if (!budget.tryConsume("outputBytes", Buffer.byteLength(output), "output_limit")) {
      return typedResult("truncated", { output: "(output budget exhausted)" }, budget, continuation, "output_limit");
    }
    return typedResult(truncated ? "truncated" : "complete", { output }, budget, continuation, reason);
  }

  async glob(value, pattern, typeFilter = "all", budget) {
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
    const base = await this.resolveExistingAsync(value, { kind: "directory", allowRoot: true });
    const matcher = globToRegExp(pattern.replace(/^\/+/, ""));
    const walked = await this.walkEntries(this.toVirtualPath(base.relativePath), budget);
    const matches = [];
    let truncated = walked.status === "truncated";
    let reason = walked.reason;
    let continuation = walked.continuation;
    for (const entry of walked.entries) {
      if (entry.relativePath !== base.relativePath) {
        const fromBase = base.relativePath
          ? entry.relativePath.slice(`${base.relativePath}/`.length)
          : entry.relativePath;
        const typeMatches = typeFilter === "all" || entry.type === typeFilter;
        if (typeMatches && matcher.test(fromBase)) {
          if (matches.length >= MAX_GLOB_RESULTS || !budget.tryConsume("matches", 1, "match_limit")) {
            truncated = true;
            reason = matches.length >= MAX_GLOB_RESULTS ? "glob_result_limit" : "match_limit";
            budget.markTruncated(reason);
            continuation = {
              pending_directories: walked.continuation?.pending_directories || 0,
              next_path: this.toVirtualPath(entry.relativePath),
            };
            break;
          }
          matches.push(this.toVirtualPath(entry.relativePath));
        }
      }
    }
    const output = matches.join("\n") || (truncated ? "(no matches in visited paths)" : "(no matches)");
    if (!budget.tryConsume("outputBytes", Buffer.byteLength(output), "output_limit")) {
      return typedResult("truncated", { output: "(output budget exhausted)" }, budget, continuation, "output_limit");
    }
    return typedResult(truncated ? "truncated" : "complete", { output }, budget, continuation, reason);
  }

  async buildRepoMap(budget) {
    return this.tree(VIRTUAL_ROOT, 2, budget);
  }
}

export const PATH_GUARD_LIMITS = Object.freeze({
  MAX_FILE_BYTES,
  MAX_CANDIDATE_RANGE_LINES,
  MAX_ELAPSED_MS,
  MAX_VISITED_ENTRIES,
  MAX_VISITED_DIRECTORIES,
  MAX_WALK_DEPTH,
  MAX_WALK_FILES,
  MAX_MATCHES,
  MAX_OUTPUT_BYTES,
  MAX_GLOB_RESULTS,
  MAX_TREE_ENTRIES,
});
