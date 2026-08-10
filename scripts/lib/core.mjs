import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import {
  CONNECT_LIMITS,
  ProtobufEncoder,
  connectFrameDecode,
  connectFrameEncode,
  extractStrings,
} from "./protobuf.mjs";
import { ToolExecutor } from "./executor.mjs";
import { ResourceBudget } from "./path-guard.mjs";
import { FastContextError } from "./public-error.mjs";

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const APP_NAME = "windsurf";
const APP_VERSION = "1.48.2";
const LANGUAGE_SERVER_VERSION = "1.9544.35";
const MAX_COMMANDS = 4;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = CONNECT_LIMITS.MAX_RESPONSE_COMPRESSED_BYTES;
const MAX_TOOL_ARGS_BYTES = 16 * 1024;
const MAX_TURNS = 3;

function networkError() {
  return new FastContextError("FC_REMOTE_UNAVAILABLE");
}

function protocolError() {
  return new FastContextError("FC_PROTOCOL_INVALID");
}

function outputLimitError() {
  return new FastContextError("FC_OUTPUT_LIMIT");
}

function requireApiKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new FastContextError("FC_KEY_MISSING");
  }
}

function systemName() {
  if (platform() === "darwin") return "Darwin";
  if (platform() === "win32") return "Windows_NT";
  return "Linux";
}

function buildMetadata(apiKey, jwt) {
  const metadata = new ProtobufEncoder();
  metadata.writeString(1, APP_NAME);
  metadata.writeString(2, APP_VERSION);
  metadata.writeString(3, apiKey);
  metadata.writeString(4, "en");
  metadata.writeString(5, JSON.stringify({
    Os: platform(),
    Arch: arch(),
    Machine: arch(),
    Nodename: "",
    Sysname: systemName(),
  }));
  metadata.writeString(7, LANGUAGE_SERVER_VERSION);
  metadata.writeString(12, APP_NAME);
  metadata.writeString(21, jwt);
  metadata.writeBytes(30, Buffer.from([0x00, 0x01]));
  return metadata;
}

function buildChatMessage(role, content, options = {}) {
  const message = new ProtobufEncoder();
  message.writeVarint(2, role);
  message.writeString(3, content);
  if (options.toolCallId && options.toolName && options.toolArgsJson) {
    const toolCall = new ProtobufEncoder();
    toolCall.writeString(1, options.toolCallId);
    toolCall.writeString(2, options.toolName);
    toolCall.writeString(3, options.toolArgsJson);
    message.writeMessage(6, toolCall);
  }
  if (options.refCallId) message.writeString(7, options.refCallId);
  return message;
}

function buildRequest(apiKey, jwt, messages, toolDefinitions) {
  const request = new ProtobufEncoder();
  request.writeMessage(1, buildMetadata(apiKey, jwt));
  for (const message of messages) {
    request.writeMessage(2, buildChatMessage(message.role, message.content, {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolArgsJson: message.toolArgsJson,
      refCallId: message.refCallId,
    }));
  }
  request.writeString(3, toolDefinitions);
  return request.toBuffer();
}

function requestSignal(timeoutMs, signal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw networkError();
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw protocolError();
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function getHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return null;
}

function validateDeclaredLength(headers, byteLimit) {
  const value = getHeader(headers, "content-length");
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return;
  try {
    if (BigInt(value.trim()) > BigInt(byteLimit)) throw outputLimitError();
  } catch (error) {
    if (error instanceof FastContextError) throw error;
  }
}

async function readChunk(reader, signal) {
  if (signal.aborted) throw networkError();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, networkError());
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => finish(resolve, value),
      () => finish(reject, networkError()),
    );
  });
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort; callers still receive a fixed error.
  }
}

async function readBoundedBody(response, byteLimit, signal) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw networkError();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw protocolError();
      if (value.byteLength === 0) continue;
      if (totalBytes > byteLimit - value.byteLength) {
        await cancelReader(reader);
        throw outputLimitError();
      }
      totalBytes += value.byteLength;
      chunks.push(Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    await cancelReader(reader);
    if (error instanceof FastContextError) throw error;
    throw networkError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled or errored.
    }
  }

  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks, totalBytes);
}

async function postBinary(fetchImpl, url, body, headers, timeoutMs, externalSignal) {
  if (typeof fetchImpl !== "function") throw networkError();
  const signal = requestSignal(timeoutMs, externalSignal);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch {
    throw networkError();
  }
  if (!response?.ok) throw networkError();

  validateDeclaredLength(response.headers, MAX_RESPONSE_BYTES);
  const data = await readBoundedBody(response, MAX_RESPONSE_BYTES, signal);
  return { data, headers: response.headers };
}

async function fetchJwt(apiKey, fetchImpl, timeoutMs, signal) {
  const metadata = new ProtobufEncoder();
  metadata.writeString(1, APP_NAME);
  metadata.writeString(2, APP_VERSION);
  metadata.writeString(3, apiKey);
  metadata.writeString(4, "en");
  metadata.writeString(7, LANGUAGE_SERVER_VERSION);
  metadata.writeString(12, APP_NAME);
  metadata.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, metadata);
  const { data: response } = await postBinary(
    fetchImpl,
    `${AUTH_BASE}/GetUserJwt`,
    outer.toBuffer(),
    {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "User-Agent": "connect-go/1.18.1",
    },
    timeoutMs,
    signal,
  );
  const jwt = extractStrings(response).find((value) => value.startsWith("eyJ") && value.includes("."));
  if (!jwt) throw networkError();
  return jwt;
}

async function streamingRequest(protoBytes, fetchImpl, timeoutMs, signal) {
  const frame = connectFrameEncode(protoBytes);
  const response = await postBinary(
    fetchImpl,
    `${API_BASE}/GetDevstralStream`,
    frame,
    {
      "Content-Type": "application/connect+proto",
      "Connect-Accept-Encoding": "gzip",
      "Connect-Content-Encoding": "gzip",
      "Connect-Protocol-Version": "1",
      "Connect-Timeout-Ms": String(timeoutMs),
      "User-Agent": "connect-go/1.18.1",
      "X-Request-Id": randomUUID(),
    },
    timeoutMs,
    signal,
  );
  return {
    data: response.data,
    encoding: getHeader(response.headers, "connect-content-encoding") || "identity",
  };
}

function commandSchema(index) {
  return {
    type: "object",
    description: `Restricted local command ${index}.`,
    oneOf: [
      {
        properties: {
          type: { type: "string", const: "rg" },
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "readfile" },
          file: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: { type: "string", const: "tree" },
          path: { type: "string" },
          levels: { type: "integer" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "ls" },
          path: { type: "string" },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "glob" },
          pattern: { type: "string" },
          path: { type: "string" },
          type_filter: { type: "string", enum: ["all", "file", "directory"] },
        },
        required: ["type", "pattern", "path"],
      },
    ],
  };
}

function toolDefinitions() {
  const properties = {};
  for (let index = 1; index <= MAX_COMMANDS; index += 1) {
    properties[`command${index}`] = commandSchema(index);
  }
  return JSON.stringify([
    {
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute only declared filesystem tools in /codebase.",
        parameters: { type: "object", properties, required: ["command1"] },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "Return candidate files and ranges in XML.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
  ]);
}

function systemPrompt() {
  return [
    "Return candidate source locations for the requested behavior.",
    "Use restricted_exec only with /codebase paths.",
    "Never request hidden, credential, generated, or repository metadata paths.",
    "Finish with answer XML containing <file path=\"/codebase/relative\"><range>start-end</range></file>.",
  ].join("\n");
}

function parseToolCall(text) {
  const marker = text.indexOf("[TOOL_CALLS]");
  if (marker < 0) throw protocolError();
  const match = text.slice(marker).match(/^\[TOOL_CALLS\](\w+)\[ARGS\](\{[\s\S]*)$/);
  if (!match) throw protocolError();
  const name = match[1];
  const source = match[2];
  let depth = 0;
  let end = -1;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quote = false;
      continue;
    }
    if (character === "\"") quote = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw protocolError();
  const json = source.slice(0, end);
  if (Buffer.byteLength(json, "utf8") > MAX_TOOL_ARGS_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    throw protocolError();
  }
  return { name, args };
}

function parseResponse(response) {
  let frames;
  try {
    frames = connectFrameDecode(response.data, { encoding: response.encoding });
  } catch (error) {
    if (error instanceof FastContextError) throw error;
    throw protocolError();
  }
  let text = "";
  for (const frame of frames) {
    for (const value of extractStrings(frame)) {
      if (value.length > 0) text += value;
      if (text.length > MAX_TOOL_ARGS_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
    }
  }
  return parseToolCall(text);
}

function queryTerms(query) {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((term) => term.length >= 3),
  )].slice(0, 8);
}

function parseAnswer(answer, guard, maxResults, query, coverage) {
  if (typeof answer !== "string" || answer.length > MAX_TOOL_ARGS_BYTES) {
    throw protocolError();
  }
  const candidates = [];
  const seen = new Set();
  const fileExpression = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let match;
  while ((match = fileExpression.exec(answer)) !== null && candidates.length < maxResults) {
    let file;
    try {
      file = guard.resolveExisting(match[2], { kind: "file" });
    } catch {
      continue;
    }
    if (seen.has(file.relativePath)) continue;
    const range = match[3].match(/<range>(\d+)-(\d+)<\/range>/);
    if (!range) continue;
    const startLine = Number(range[1]);
    const endLine = Number(range[2]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      continue;
    }
    seen.add(file.relativePath);
    candidates.push({
      path: file.relativePath,
      start_line: startLine,
      end_line: endLine,
      reason: "semantic_candidate",
    });
  }
  const candidateLimitReached = candidates.length >= maxResults;
  const reasons = new Set(coverage.reasons);
  if (candidateLimitReached) reasons.add("candidate_result_limit");
  const truncated = candidateLimitReached || coverage.truncated;
  return {
    status: truncated ? "truncated" : "complete",
    search_terms: queryTerms(query),
    candidates,
    truncated,
    coverage: {
      visited: coverage.visited,
      continuation: coverage.continuation,
      reasons: [...reasons].sort(),
    },
  };
}

function searchCoverage(budget, repoMap, executor) {
  const snapshot = budget.snapshot();
  const executorCoverage = executor.coverage();
  const reasons = new Set(snapshot.reasons);
  if (repoMap.status === "truncated" && repoMap.reason) reasons.add(repoMap.reason);
  if (executorCoverage.failed) reasons.add("local_tool_failure");
  return {
    truncated: repoMap.status === "truncated" || executorCoverage.truncated,
    visited: snapshot.visited,
    continuation: executorCoverage.continuation || repoMap.continuation || null,
    reasons: [...reasons].sort(),
  };
}

/**
 * @param {{
 *   query: string,
 *   guard: import("./path-guard.mjs").PathGuard,
 *   apiKey: string,
 *   maxResults?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   resourceLimits?: Partial<typeof import("./path-guard.mjs").RESOURCE_LIMITS>,
 *   now?: () => number,
 * }} options
 */
export async function search({
  query,
  guard,
  apiKey,
  maxResults = 10,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  signal,
  resourceLimits,
  now,
}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new FastContextError("FC_QUERY_REQUIRED");
  }
  requireApiKey(apiKey);
  if (!guard || typeof guard.buildRepoMap !== "function") throw protocolError();

  const budget = new ResourceBudget({ timeoutMs, signal, limits: resourceLimits, now });
  try {
    const boundedResults = Math.max(1, Math.min(50, Number(maxResults) || 10));
    const jwt = await fetchJwt(apiKey, fetchImpl, budget.remainingMs(), budget.signal);
    const executor = new ToolExecutor(guard, { budget });
    const repoMap = await guard.buildRepoMap(budget);
    const messages = [
      { role: 5, content: systemPrompt() },
      {
        role: 1,
        content: `Problem statement:\n${query.slice(0, 2000)}\n\nRepository map result:\n${JSON.stringify(repoMap)}`,
      },
    ];
    const definitions = toolDefinitions();

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const request = buildRequest(apiKey, jwt, messages, definitions);
      if (request.length > MAX_REQUEST_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
      const response = await streamingRequest(
        request,
        fetchImpl,
        budget.remainingMs(),
        budget.signal,
      );
      const toolCall = parseResponse(response);

      if (toolCall.name === "answer") {
        return parseAnswer(
          toolCall.args.answer,
          guard,
          boundedResults,
          query,
          searchCoverage(budget, repoMap, executor),
        );
      }
      if (toolCall.name !== "restricted_exec") throw protocolError();

      const toolResults = await executor.execToolCall(toolCall.args);
      const toolCallId = randomUUID();
      messages.push({
        role: 2,
        content: "restricted local tool request accepted",
        toolCallId,
        toolName: "restricted_exec",
        toolArgsJson: JSON.stringify(toolCall.args),
      });
      messages.push({ role: 4, content: toolResults, refCallId: toolCallId });
    }

    throw protocolError();
  } finally {
    budget.dispose();
  }
}

export async function searchWithContent({
  query,
  projectRoot,
  apiKey,
  maxResults = 10,
  denyPatterns = [],
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 30000,
}) {
  const { PathGuard } = await import("./path-guard.mjs");
  const guard = new PathGuard(projectRoot, denyPatterns);
  const result = await search({ query, guard, apiKey, maxResults, fetchImpl, signal, timeoutMs });
  return JSON.stringify(result);
}

export const CORE_LIMITS = Object.freeze({
  MAX_COMMANDS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TOOL_ARGS_BYTES,
  MAX_TURNS,
});
