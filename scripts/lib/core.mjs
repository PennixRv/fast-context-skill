import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { gzipSync } from "node:zlib";
import {
  CONNECT_LIMITS,
  ProtobufEncoder,
  connectFrameDecode,
  connectFrameEncode,
  extractStrings,
} from "./protobuf.mjs";
import { EXECUTOR_LIMITS, ToolExecutor } from "./executor.mjs";
import { RESOURCE_BUDGET_ABORT, RESOURCE_LIMITS, ResourceBudget } from "./path-guard.mjs";
import { FastContextError } from "./public-error.mjs";

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const APP_NAME = "windsurf";
const APP_VERSION = "1.48.2";
const LANGUAGE_SERVER_VERSION = "1.9544.35";
const WS_MODEL = "MODEL_SWE_1_6_FAST";
const CONNECT_USER_AGENT = "connect-go/1.18.1 (go1.25.5)";
const MAX_COMMANDS = EXECUTOR_LIMITS.MAX_COMMANDS;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = CONNECT_LIMITS.MAX_RESPONSE_COMPRESSED_BYTES;
const MAX_TOOL_FORMAT_RETRIES = 1;
const MAX_ANSWER_FORMAT_RETRIES = 1;
const MAX_STREAM_RETRIES = 2;
const MAX_SESSION_REFRESHES = 2;
const STREAM_RETRY_BACKOFF_MS = 1_000;
const SESSION_REFRESH_BACKOFF_MS = 5_000;
const MAX_TOOL_ARGS_BYTES = 16 * 1024;
// Three bounded local-tool rounds plus one answer-only protocol turn.
const MAX_TURNS = 4;

function networkError(protocolReason) {
  const error = new FastContextError("FC_REMOTE_UNAVAILABLE");
  if (typeof protocolReason === "string") {
    Object.defineProperty(error, "protocolReason", {
      value: protocolReason,
      enumerable: false,
    });
  }
  return error;
}

function authError() {
  return new FastContextError("FC_AUTH_REJECTED");
}

function timeoutError() {
  return new FastContextError("FC_REMOTE_TIMEOUT");
}

function serverError() {
  return new FastContextError("FC_REMOTE_SERVER_ERROR");
}

function protocolError(protocolReason) {
  const error = new FastContextError("FC_PROTOCOL_INVALID");
  if (typeof protocolReason === "string") {
    Object.defineProperty(error, "protocolReason", {
      value: protocolReason,
      enumerable: false,
    });
  }
  return error;
}

function retryableToolFormatError() {
  const error = protocolError("tool_call_format_invalid");
  error.retryableToolFormat = true;
  return error;
}

function notifyProtocol(observer, event) {
  if (typeof observer !== "function") return;
  try {
    observer(Object.freeze(event));
  } catch {
    // Optional diagnostics cannot alter the bounded search outcome.
  }
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
  // The service expects this schema shape, but the client deliberately avoids
  // host, CPU, memory, and OS-version fingerprinting.
  metadata.writeString(5, JSON.stringify({
    Os: platform(),
    Arch: arch(),
    Release: "0",
    Version: "0",
    Machine: arch(),
    Nodename: "",
    Sysname: systemName(),
    ProductVersion: "0",
  }));
  metadata.writeString(7, LANGUAGE_SERVER_VERSION);
  metadata.writeString(8, JSON.stringify({
    NumSockets: 1,
    NumCores: 1,
    NumThreads: 1,
    VendorID: "",
    Family: "0",
    Model: "0",
    ModelName: "",
    Memory: 0,
  }));
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

function requestSignal(timeoutMs, externalSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw networkError();
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw protocolError();
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => {
    if (
      externalSignal?.reason === RESOURCE_BUDGET_ABORT.DEADLINE
      || externalSignal?.reason?.name === "TimeoutError"
    ) {
      timedOut = true;
    }
    controller.abort();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.floor(timeoutMs)));
  timer.unref?.();
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    failure() { return timedOut ? timeoutError() : networkError(); },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
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

async function readChunk(reader, request) {
  if (request.signal.aborted) throw request.failure();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, request.failure());
    request.signal.addEventListener("abort", onAbort, { once: true });
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

async function readBoundedBody(response, byteLimit, request) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw networkError();
  const body = Buffer.alloc(byteLimit);
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await readChunk(reader, request);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw protocolError();
      if (value.byteLength === 0) continue;
      if (totalBytes > byteLimit - value.byteLength) {
        await cancelReader(reader);
        throw outputLimitError();
      }
      body.set(value, totalBytes);
      totalBytes += value.byteLength;
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

  return totalBytes === 0 ? Buffer.alloc(0) : body.subarray(0, totalBytes);
}

async function postBinary(fetchImpl, url, body, headers, timeoutMs, externalSignal) {
  if (typeof fetchImpl !== "function") throw networkError();
  const request = requestSignal(timeoutMs, externalSignal);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });
  } catch {
    throw request.failure();
  } finally {
    if (!response) request.dispose();
  }
  try {
    if (request.signal.aborted) throw request.failure();
    if (response?.status === 401 || response?.status === 403) throw authError();
    if (Number.isInteger(response?.status) && response.status >= 500 && response.status <= 599) {
      throw serverError();
    }
    if (response?.status === 429) throw networkError("http_rate_limited");
    if (!response?.ok) throw networkError();

    validateDeclaredLength(response.headers, MAX_RESPONSE_BYTES);
    const data = await readBoundedBody(response, MAX_RESPONSE_BYTES, request);
    return { data, headers: response.headers };
  } finally {
    request.dispose();
  }
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
      "Accept-Encoding": "gzip",
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "User-Agent": CONNECT_USER_AGENT,
    },
    timeoutMs,
    signal,
  );
  const jwt = extractStrings(response).find((value) => value.startsWith("eyJ") && value.includes("."));
  if (!jwt) throw protocolError();
  return jwt;
}

async function checkRateLimit(apiKey, jwt, fetchImpl, timeoutMs, signal) {
  const request = new ProtobufEncoder();
  request.writeMessage(1, buildMetadata(apiKey, jwt));
  request.writeString(3, WS_MODEL);
  const body = gzipSync(request.toBuffer());
  if (body.length > MAX_REQUEST_BYTES) throw outputLimitError();
  await postBinary(
    fetchImpl,
    `${API_BASE}/CheckUserMessageRateLimit`,
    body,
    {
      "Accept-Encoding": "gzip",
      "Content-Encoding": "gzip",
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "User-Agent": CONNECT_USER_AGENT,
    },
    timeoutMs,
    signal,
  );
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
      "User-Agent": CONNECT_USER_AGENT,
      "Accept-Encoding": "identity",
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
          type: { type: "string", const: "rg", description: "Search file contents with ripgrep." },
          pattern: { type: "string", description: "A bounded ripgrep pattern." },
          path: { type: "string", description: "An existing /codebase file or directory." },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "readfile", description: "Read numbered source rows." },
          file: { type: "string", description: "An existing /codebase file." },
          start_line: { type: "integer", description: "Positive inclusive first row." },
          end_line: { type: "integer", description: "Positive inclusive last row." },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: { type: "string", const: "tree", description: "Display a bounded directory tree." },
          path: { type: "string", description: "An existing /codebase directory." },
          levels: { type: "integer", description: "Bounded depth." },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "ls", description: "List a bounded directory." },
          path: { type: "string", description: "An existing /codebase directory." },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "glob", description: "Find bounded paths by glob." },
          pattern: { type: "string", description: "A relative glob pattern." },
          path: { type: "string", description: "An existing /codebase file or directory." },
          type_filter: { type: "string", enum: ["all", "file", "directory"] },
        },
        required: ["type", "pattern", "path"],
      },
    ],
  };
}

function toolDefinitions({ allowRestrictedExec = true } = {}) {
  const properties = {};
  for (let index = 1; index <= MAX_COMMANDS; index += 1) {
    properties[`command${index}`] = commandSchema(index);
  }
  const definitions = [];
  if (allowRestrictedExec) {
    definitions.push({
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute up to four declared rg, readfile, tree, ls, or glob commands in /codebase.",
        parameters: { type: "object", properties, required: ["command1"] },
      },
    });
  }
  definitions.push({
      type: "function",
      function: {
        name: "answer",
        description: "Return locally evidenced candidate files and ranges, or the exact no-results marker.",
        parameters: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "Final XML with locally evidenced /codebase paths and inclusive line ranges.",
            },
          },
          required: ["answer"],
        },
      },
  });
  return JSON.stringify(definitions);
}

function formatRepositoryMap(repoMap) {
  const status = ["complete", "truncated", "failure"].includes(repoMap?.status)
    ? repoMap.status
    : "failure";
  const output = typeof repoMap?.output === "string" && repoMap.output.length > 0
    ? repoMap.output
    : "(no repository paths available)";
  return [
    `Repo Map (bounded local tree rooted at /codebase; status: ${status}):`,
    "```text",
    output,
    "```",
    status === "complete"
      ? "This map is orientation only. Verify every candidate path and range with restricted_exec before answering."
      : "This map is incomplete. Use restricted_exec to verify paths and ranges before answering.",
  ].join("\n");
}

function systemPrompt(maxResults) {
  return [
    "You are an expert software engineer providing source context to another engineer who must understand and change the current codebase.",
    "Return every file needed to understand the requested behavior, not only files likely to be edited. Include complete semantic blocks when the available read range permits it.",
    "",
    "# ENVIRONMENT",
    "The working directory is /codebase. Use restricted_exec only with declared /codebase paths.",
    "Never request hidden, credential, generated, repository metadata, outside-root, or symlink-escaping paths.",
    "Never send shell text, cwd, paths outside /codebase, unsupported command fields, comments, or a JSON array.",
    "",
    "# THINKING AND SEARCH",
    "Think step-by-step before each tool request. Only an exact tool envelope is protocol-bearing: the client discards all text outside it, never executes that text, and never sends it back in a later request.",
    "Use MAP to orient from the repository map, ANCHOR with narrow rg searches, TRACE imports with targeted rg, then VERIFY candidates with readfile.",
    "Start narrow in likely source roots and widen only when needed. Tree, ls, glob, and rg are orientation or anchor evidence, not final range proof.",
    "After an rg result identifies a plausible implementation path, the next restricted_exec call must reserve at least one command for readfile on the strongest implementation candidate before issuing more widening searches.",
    "Read the implementation before its test whenever both are available. Never return a test as the only candidate when a verified implementation is available.",
    "If a command fails or returns no matches, change the search strategy within the remaining bounded turns.",
    "",
    "# TOOL FORMAT",
    "A restricted call is exactly [TOOL_CALLS]restricted_exec[ARGS] followed immediately by one complete JSON object with one to four command1 through command4 properties.",
    "Each command is exactly one declared object: rg needs type, pattern, path; readfile needs type, file, start_line, end_line; tree needs type, path, levels; ls needs type, path; glob needs type, pattern, path.",
    "Example: [TOOL_CALLS]restricted_exec[ARGS]{\"command1\":{\"type\":\"rg\",\"pattern\":\"symbol\",\"path\":\"/codebase/src\"},\"command2\":{\"type\":\"readfile\",\"file\":\"/codebase/src/example.ts\",\"start_line\":1,\"end_line\":80}}",
    "Use no more than three restricted_exec rounds and no more than four commands per round. Once local evidence is sufficient, call answer immediately; never request another tool turn solely to use a remaining round.",
    "readfile returns numbered rows as N:source and a locally generated read_range with exact inclusive bounds. Copy candidate bounds from read_range; never estimate a path or line number.",
    "",
    "# ANSWER FORMAT",
    "Finish exactly as [TOOL_CALLS]answer[ARGS] followed immediately by one complete JSON object with an answer field.",
    "The answer field contains an <ANSWER> root with <file path=\"/codebase/relative\"><range>start-end</range></file> entries. A file may contain multiple inclusive ranges, each copied from prior readfile evidence.",
    "Example: [TOOL_CALLS]answer[ARGS]{\"answer\":\"<ANSWER><file path=\\\"/codebase/src/example.ts\\\"><range>10-20</range><range>40-60</range></file></ANSWER>\"}",
    "After at most three restricted_exec calls, the following turn must call answer using the locally verified evidence already available.",
    "",
    "# NO RESULTS",
    "Only after thorough bounded searching finds no relevant candidate, return exactly [TOOL_CALLS]answer[ARGS]{\"answer\":\"<ANSWER></ANSWER>\"}.",
    "An empty answer is better than an unrelated file, but never use an empty answer when local tool evidence identified a relevant implementation.",
    `Return at most ${maxResults} candidate entries, ordered with the strongest implementation evidence first.`,
  ].join("\n");
}

function forceAnswerPrompt(maxResults) {
  return [
    "You have no tool turns left. Call answer now.",
    "Do not request restricted_exec or any other tool.",
    "Your entire response must be exactly [TOOL_CALLS]answer[ARGS] followed immediately by one complete JSON object.",
    "Return only locally evidenced candidates inside <ANSWER> as <file path=\"/codebase/relative\"><range>start-end</range></file> entries; a file may contain multiple ranges.",
    "For every candidate range, copy its positive N-N bounds exactly from a prior readfile read_range and keep it wholly within the returned N:source rows.",
    "If there are no such candidates, use exactly <ANSWER></ANSWER>.",
    `Return at most ${maxResults} candidate entries; do not guess paths or line ranges.`,
  ].join("\n");
}

function answerCorrectionPrompt(projection, maxResults) {
  const reasons = Array.isArray(projection.rejection_reasons)
    ? projection.rejection_reasons.join(", ")
    : "remote_candidate_projection_rejected";
  return [
    `The previous answer had ${projection.rejected_candidates} locally rejected candidate entries (${reasons}).`,
    "This is the only answer-format correction attempt. Call answer now and do not request restricted_exec or any other tool.",
    "Your entire response must be exactly [TOOL_CALLS]answer[ARGS] followed immediately by one complete JSON object.",
    "A valid range is one positive N-N pair copied from a prior readfile read_range and wholly within its N:source rows. Return every candidate again only when its exact path and range meet that rule.",
    "Otherwise return exactly <ANSWER></ANSWER>; do not use prose or guess a path or line range.",
    `Return at most ${maxResults} candidate entries.`,
  ].join("\n");
}

function answerShapeCorrectionPrompt(maxResults) {
  return [
    "The previous answer did not use the required explicit candidate or no-result structure.",
    "This is the only answer-format correction attempt. Call answer now and do not request restricted_exec or any other tool.",
    "Your entire response must be exactly [TOOL_CALLS]answer[ARGS] followed immediately by one complete JSON object.",
    "Inside the answer field, use <ANSWER><file path=\"/codebase/relative\"><range>start-end</range></file></ANSWER> with ranges copied from prior readfile evidence.",
    "If and only if there is no locally evidenced candidate, use exactly <ANSWER></ANSWER>. Do not use prose or guess a path or line range.",
    `Return at most ${maxResults} candidate entries.`,
  ].join("\n");
}

function toolFormatCorrectionPrompt(finalTurn) {
  const allowedTool = finalTurn ? "answer" : "restricted_exec or answer";
  return [
    "The previous tool-call envelope was invalid. This is the only tool-format correction attempt for this request.",
    `Call only ${allowedTool} using exactly [TOOL_CALLS]tool_name[ARGS] followed immediately by one valid JSON object.`,
    "The first character must be [, and there must be no prose, Markdown, XML, code fence, comment, trailing comma, or text outside the JSON object.",
    finalTurn
      ? "This is answer-only: do not request restricted_exec."
      : "For restricted_exec, use only the documented structured local-tool schema.",
  ].join("\n");
}

function canRetryAnswerFormat(answerResult) {
  if (answerResult.projection.rejected_candidates === 0) return false;
  const retryableReasons = new Set([
    "remote_candidate_missing_range",
    "remote_candidate_malformed",
    "remote_candidate_range_rejected",
  ]);
  return answerResult.projection.rejection_reasons.length > 0
    && answerResult.projection.rejection_reasons.every((reason) => retryableReasons.has(reason))
    && !answerResult.coverage.reasons.includes("candidate_changed");
}

function repairJsonText(text) {
  return String(text)
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)"\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
}

function parseJsonWithBoundedRepair(text) {
  try {
    return { value: JSON.parse(text), recovery: null };
  } catch {
    const repaired = repairJsonText(text);
    if (repaired === text) return null;
    try {
      return { value: JSON.parse(repaired), recovery: "json_repaired" };
    } catch {
      return null;
    }
  }
}

function extractBalancedObject(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function salvageRestrictedExecArgs(text) {
  const commands = {};
  let depth = 0;
  let quote = null;
  let escaped = false;
  let previousSignificant = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      if (depth !== 1 || (previousSignificant !== "{" && previousSignificant !== ",")) {
        quote = character;
        continue;
      }
    }
    if (depth === 1 && (previousSignificant === "{" || previousSignificant === ",")) {
      const match = text.slice(index).match(/^(?:["'](command[1-4])["']|(command[1-4]))\s*:\s*(\{)/);
      if (match) {
        const commandKey = match[1] || match[2];
        const start = index + match[0].lastIndexOf("{");
        const objectText = extractBalancedObject(text, start);
        if (objectText) {
          const parsed = parseJsonWithBoundedRepair(objectText);
          if (
            parsed?.value
            && typeof parsed.value === "object"
            && !Array.isArray(parsed.value)
            && ["rg", "readfile", "tree", "ls", "glob"].includes(parsed.value.type)
          ) {
            commands[commandKey] = parsed.value;
          }
          index = start + objectText.length - 1;
          previousSignificant = "}";
          continue;
        }
      }
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (!/\s/.test(character)) previousSignificant = character;
  }
  return Object.keys(commands).length > 0 ? commands : null;
}

function salvageAnswerArgs(text) {
  const match = String(text).match(/^\s*\{\s*"answer"\s*:\s*("(?:\\.|[^"\\])*")/s);
  if (!match) return null;
  try {
    const answer = JSON.parse(match[1]);
    return typeof answer === "string" ? { answer } : null;
  } catch {
    return null;
  }
}

function parseToolCall(text) {
  const marker = text.indexOf("[TOOL_CALLS]");
  if (marker < 0) throw retryableToolFormatError();
  const match = text.slice(marker).match(/^\[TOOL_CALLS\][ \t\r\n]*(\w+)[ \t\r\n]*\[ARGS\][ \t\r\n]*(\{[\s\S]*)$/);
  if (!match) throw retryableToolFormatError();
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
  const json = end < 0 ? source : source.slice(0, end);
  if (Buffer.byteLength(json, "utf8") > MAX_TOOL_ARGS_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
  if (end >= 0) {
    const trailing = source.slice(end).trim();
    if (trailing !== "" && trailing !== "</s>") throw retryableToolFormatError();
  }
  const parsed = parseJsonWithBoundedRepair(json);
  if (parsed?.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
    return { name, args: parsed.value, recovery: parsed.recovery };
  }
  if (name === "restricted_exec") {
    const args = salvageRestrictedExecArgs(json);
    if (args) return { name, args, recovery: "commands_salvaged" };
  }
  if (name === "answer") {
    const args = salvageAnswerArgs(repairJsonText(json));
    if (args) return { name, args, recovery: "answer_salvaged" };
  }
  throw retryableToolFormatError();
}

function isRetryableStreamFailure(error) {
  return error?.code === "FC_REMOTE_UNAVAILABLE"
    && [
      "connect_end_stream_resource_exhausted",
      "connect_end_stream_unavailable",
      "http_rate_limited",
    ].includes(error?.protocolReason);
}

function isRefreshableCapacityFailure(error) {
  return error?.code === "FC_REMOTE_UNAVAILABLE"
    && error?.protocolReason === "connect_end_stream_resource_exhausted";
}

async function waitForStreamRetry(signal, delayMs) {
  if (signal.aborted) throw networkError();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    timer.unref?.();
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(networkError());
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function requestToolCall(request, fetchImpl, budget, onRetry, waitImpl = waitForStreamRetry) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await streamingRequest(
        request,
        fetchImpl,
        budget.remainingMs(),
        budget.signal,
      );
      return parseResponse(response);
    } catch (error) {
      if (!isRetryableStreamFailure(error) || attempt >= MAX_STREAM_RETRIES) throw error;
      const retry = attempt + 1;
      onRetry?.({
        event: "stream_retry",
        attempt: retry,
        code: error.code,
        protocol_reason: error.protocolReason,
      });
      const remaining = budget.remainingMs();
      const delay = Math.min(STREAM_RETRY_BACKOFF_MS * retry, Math.max(0, remaining - 1));
      if (delay <= 0) throw error;
      await waitImpl(budget.signal, delay);
    }
  }
}

function parseResponse(response) {
  let frames;
  try {
    frames = connectFrameDecode(response.data, { encoding: response.encoding });
  } catch (error) {
    if (error instanceof FastContextError && error.code !== "FC_PROTOCOL_INVALID") throw error;
    throw protocolError(
      typeof error?.protocolReason === "string" ? error.protocolReason : "connect_envelope_invalid",
    );
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

function isTestPath(relativePath) {
  return /(^|\/)(?:__tests__|test|tests|spec)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(relativePath);
}

async function parseAnswer(answer, guard, maxResults, query, budget, repoMap, executor) {
  if (typeof answer !== "string" || Buffer.byteLength(answer, "utf8") > MAX_TOOL_ARGS_BYTES) {
    throw protocolError("answer_argument_invalid");
  }
  const normalizedAnswer = answer.trim();
  const candidates = [];
  const seen = new Set();
  if (
    normalizedAnswer === "<no_results/>"
    || /^<ANSWER>\s*<\/ANSWER>$/.test(normalizedAnswer)
  ) {
    const coverage = searchCoverage(budget, repoMap, executor);
    return answerResult({
      candidates,
      projection: {
        remote_candidates: 0,
        accepted_candidates: 0,
        recovered_candidates: 0,
        rejected_candidates: 0,
        unprocessed_candidates: 0,
        rejection_reasons: [],
      },
      query,
      coverage,
    });
  }

  const candidateMarkers = [...answer.matchAll(/<file\b[^>]*>/g)];
  if (candidateMarkers.length === 0) {
    throw protocolError("answer_missing_explicit_no_results");
  }

  const fileExpression = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let matchedFileElements = 0;
  let remoteCandidates = 0;
  let recoveredCandidates = 0;
  let rejectedCandidates = 0;
  let unprocessedCandidates = 0;
  const rejectionReasons = new Set();
  const addCandidate = (validated, { prepend = false } = {}) => {
    const identity = `${validated.relativePath}:${validated.startLine}-${validated.endLine}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const candidate = {
      path: validated.relativePath,
      start_line: validated.startLine,
      end_line: validated.endLine,
      reason: "local_range_validated",
    };
    if (prepend) candidates.unshift(candidate);
    else candidates.push(candidate);
    return true;
  };
  const recoverCandidate = async (
    path,
    preferredRange = null,
    reason = "remote_candidate_range_recovered",
  ) => {
    if (budget.snapshot().reasons.includes("candidate_changed")) return null;
    try {
      const recovered = await executor.recoverCandidateRange(path, preferredRange);
      if (recovered) budget.markTruncated(reason);
      return recovered;
    } catch (error) {
      if (budget.signal.aborted || error?.code === "FC_REMOTE_UNAVAILABLE") throw networkError();
      return null;
    }
  };
  let match;
  while ((match = fileExpression.exec(answer)) !== null) {
    matchedFileElements += 1;
    const ranges = [...match[3].matchAll(/<range>([1-9]\d*)-([1-9]\d*)<\/range>/g)];
    if (ranges.length === 0) {
      remoteCandidates += 1;
      if (candidates.length >= maxResults) {
        unprocessedCandidates += 1;
        continue;
      }
      const recovered = await recoverCandidate(match[2]);
      if (recovered && addCandidate(recovered)) continue;
      rejectedCandidates += 1;
      rejectionReasons.add("remote_candidate_missing_range");
      continue;
    }
    for (const range of ranges) {
      remoteCandidates += 1;
      if (candidates.length >= maxResults) {
        unprocessedCandidates += 1;
        continue;
      }
      const startLine = Number(range[1]);
      const endLine = Number(range[2]);
      let validated;
      try {
        validated = await guard.validateCandidateRange(match[2], startLine, endLine, budget);
      } catch (error) {
        if (budget.signal.aborted || error?.code === "FC_REMOTE_UNAVAILABLE") throw networkError();
        rejectedCandidates += 1;
        rejectionReasons.add(
          String(error?.code || "").startsWith("FC_PATH")
            ? "remote_candidate_path_rejected"
            : "remote_candidate_range_rejected",
        );
        continue;
      }
      if (!validated) {
        const recovered = await recoverCandidate(match[2], { start_line: startLine, end_line: endLine });
        if (recovered && addCandidate(recovered)) continue;
        rejectedCandidates += 1;
        rejectionReasons.add(
          budget.snapshot().reasons.includes("candidate_changed")
            ? "remote_candidate_file_changed"
            : "remote_candidate_range_rejected",
        );
        continue;
      }
      if (!addCandidate(validated)) {
        rejectedCandidates += 1;
        rejectionReasons.add("remote_candidate_duplicate");
      }
    }
  }
  const malformedCandidates = Math.max(0, candidateMarkers.length - matchedFileElements);
  if (malformedCandidates > 0) rejectionReasons.add("remote_candidate_malformed");
  remoteCandidates += malformedCandidates;
  rejectedCandidates += malformedCandidates;
  if (candidates.length < maxResults) {
    const implementationCandidates = candidates.filter((candidate) => !isTestPath(candidate.path));
    const readEvidence = executor.implementationEvidencePaths({ includeRg: false });
    const primaryRead = readEvidence[0];
    const recoveryPaths = primaryRead && !candidates.some((candidate) => candidate.path === primaryRead)
      ? [primaryRead]
      : [];
    for (const evidencePath of recoveryPaths) {
      if (candidates.some((candidate) => candidate.path === evidencePath)) continue;
      const recovered = await recoverCandidate(
        `/codebase/${evidencePath}`,
        null,
        "implementation_candidate_recovered",
      );
      if (recovered && addCandidate(recovered, { prepend: true })) {
        recoveredCandidates += 1;
        break;
      }
    }
    if (recoveredCandidates === 0 && implementationCandidates.length === 0) {
      try {
        const imported = await executor.recoverImportedImplementation(
          candidates.filter((candidate) => isTestPath(candidate.path)).map((candidate) => candidate.path),
        );
        if (imported && addCandidate(imported, { prepend: true })) {
          recoveredCandidates += 1;
          budget.markTruncated("implementation_candidate_recovered");
        }
      } catch (error) {
        if (budget.signal.aborted || error?.code === "FC_REMOTE_UNAVAILABLE") throw networkError();
      }
    }
    if (recoveredCandidates === 0 && implementationCandidates.length === 0 && !primaryRead) {
      const rgPath = executor.implementationEvidencePaths({ includeRg: true })[0];
      if (rgPath) {
        const recovered = await recoverCandidate(
          `/codebase/${rgPath}`,
          null,
          "implementation_candidate_recovered",
        );
        if (recovered && addCandidate(recovered, { prepend: true })) recoveredCandidates += 1;
      }
    }
  }
  const coverage = searchCoverage(budget, repoMap, executor);
  return answerResult({
    candidates,
    projection: {
      remote_candidates: remoteCandidates,
      accepted_candidates: candidates.length,
      recovered_candidates: recoveredCandidates,
      rejected_candidates: rejectedCandidates,
      unprocessed_candidates: unprocessedCandidates,
      rejection_reasons: [...rejectionReasons].sort(),
    },
    query,
    coverage,
  });
}

function answerResult({ candidates, projection, query, coverage }) {
  const candidateLimitReached = projection.unprocessed_candidates > 0;
  const projectionRejected = projection.rejected_candidates > 0;
  const reasons = new Set(coverage.reasons);
  if (candidateLimitReached) reasons.add("candidate_result_limit");
  if (projectionRejected) reasons.add("remote_candidate_projection_rejected");
  const truncated = candidateLimitReached || projectionRejected || coverage.truncated;
  return {
    status: truncated ? "truncated" : "complete",
    search_terms: queryTerms(query),
    candidates,
    truncated,
    projection,
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
    truncated: snapshot.reasons.length > 0 || repoMap.status === "truncated" || executorCoverage.truncated,
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
 *   waitImpl?: (signal: AbortSignal, delayMs: number) => Promise<void>,
 *   onProtocolEvent?: (event: { turn: number, final_turn: boolean, event?: string, tool_name?: string, command_index?: string, command_type?: string, status?: string, reason?: string | null, code?: string | null, protocol_reason?: string }) => void,
 * }} options
 */
export async function search({
  query,
  guard,
  apiKey,
  maxResults = 10,
  timeoutMs = RESOURCE_LIMITS.MAX_ELAPSED_MS,
  fetchImpl = globalThis.fetch,
  signal,
  resourceLimits,
  now,
  waitImpl = waitForStreamRetry,
  onProtocolEvent,
}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new FastContextError("FC_QUERY_REQUIRED");
  }
  requireApiKey(apiKey);
  if (
    !guard
    || typeof guard.buildRepoMap !== "function"
    || typeof guard.validateCandidateRange !== "function"
  ) {
    throw protocolError();
  }

  const budget = new ResourceBudget({ timeoutMs, signal, limits: resourceLimits, now });
  try {
    const boundedResults = Math.max(1, Math.min(50, Number(maxResults) || 10));
    let jwt = await fetchJwt(apiKey, fetchImpl, budget.remainingMs(), budget.signal);
    notifyProtocol(onProtocolEvent, { event: "rate_limit_preflight", status: "started" });
    try {
      await checkRateLimit(apiKey, jwt, fetchImpl, budget.remainingMs(), budget.signal);
    } catch (error) {
      notifyProtocol(onProtocolEvent, {
        event: "rate_limit_preflight",
        status: "failed",
        code: typeof error?.code === "string" ? error.code : "FC_REMOTE_UNAVAILABLE",
        protocol_reason: typeof error?.protocolReason === "string"
          ? error.protocolReason
          : undefined,
      });
      throw error;
    }
    notifyProtocol(onProtocolEvent, { event: "rate_limit_preflight", status: "complete" });
    let observedTurn = 0;
    const executor = new ToolExecutor(guard, {
      budget,
      onCommandResult(event) {
        notifyProtocol(onProtocolEvent, {
          event: "local_tool",
          turn: observedTurn,
          final_turn: false,
          ...event,
        });
      },
    });
    const repoMap = await guard.buildRepoMap(budget);
    const messages = [
      { role: 5, content: systemPrompt(boundedResults) },
      {
        role: 1,
        content: `Problem Statement: ${query.slice(0, 2000)}\n\n${formatRepositoryMap(repoMap)}`,
      },
    ];
    const definitions = toolDefinitions();
    let answerFormatRetries = 0;
    let sessionRefreshes = 0;
    const requestWithRetry = async (requestDefinitions, turn, finalTurn) => {
      const performRequest = () => {
        const request = buildRequest(apiKey, jwt, messages, requestDefinitions);
        if (request.length > MAX_REQUEST_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
        return requestToolCall(
          request,
          fetchImpl,
          budget,
          (event) => notifyProtocol(onProtocolEvent, {
            ...event,
            turn,
            final_turn: finalTurn,
          }),
          waitImpl,
        );
      };
      while (true) {
        try {
          return await performRequest();
        } catch (error) {
          if (!isRefreshableCapacityFailure(error) || sessionRefreshes >= MAX_SESSION_REFRESHES) {
            throw error;
          }
          sessionRefreshes += 1;
          notifyProtocol(onProtocolEvent, {
            event: "session_refresh",
            status: "started",
            attempt: sessionRefreshes,
            turn,
            final_turn: finalTurn,
          });
          try {
            const remaining = budget.remainingMs();
            const delay = Math.min(SESSION_REFRESH_BACKOFF_MS, Math.max(0, remaining - 1));
            if (delay <= 0) throw error;
            await waitImpl(budget.signal, delay);
            jwt = await fetchJwt(apiKey, fetchImpl, budget.remainingMs(), budget.signal);
            await checkRateLimit(apiKey, jwt, fetchImpl, budget.remainingMs(), budget.signal);
          } catch (refreshError) {
            notifyProtocol(onProtocolEvent, {
              event: "session_refresh",
              status: "failed",
              attempt: sessionRefreshes,
              turn,
              final_turn: finalTurn,
              code: typeof refreshError?.code === "string"
                ? refreshError.code
                : "FC_REMOTE_UNAVAILABLE",
              protocol_reason: typeof refreshError?.protocolReason === "string"
                ? refreshError.protocolReason
                : undefined,
            });
            throw refreshError;
          }
          notifyProtocol(onProtocolEvent, {
            event: "session_refresh",
            status: "complete",
            attempt: sessionRefreshes,
            turn,
            final_turn: finalTurn,
          });
        }
      }
    };
    const requestWithFormatCorrection = async (requestDefinitions, turn, finalTurn) => {
      let formatRetries = 0;
      while (true) {
        try {
          const call = await requestWithRetry(requestDefinitions, turn, finalTurn);
          if (formatRetries > 0) {
            notifyProtocol(onProtocolEvent, {
              event: "tool_format_correction",
              turn,
              final_turn: finalTurn,
              tool_name: call.name,
            });
          }
          return call;
        } catch (error) {
          if (!error?.retryableToolFormat || formatRetries >= MAX_TOOL_FORMAT_RETRIES) {
            notifyProtocol(onProtocolEvent, {
              event: formatRetries > 0 ? "tool_format_correction" : undefined,
              turn,
              final_turn: finalTurn,
              code: typeof error?.code === "string" ? error.code : "FC_REMOTE_UNAVAILABLE",
              protocol_reason: typeof error?.protocolReason === "string"
                ? error.protocolReason
                : undefined,
            });
            throw error;
          }
          formatRetries += 1;
          messages.push({ role: 1, content: toolFormatCorrectionPrompt(finalTurn) });
        }
      }
    };

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const finalTurn = turn === MAX_TURNS - 1;
      const requestDefinitions = finalTurn
        ? toolDefinitions({ allowRestrictedExec: false })
        : definitions;
      const toolCall = await requestWithFormatCorrection(requestDefinitions, turn + 1, finalTurn);
      notifyProtocol(onProtocolEvent, {
        turn: turn + 1,
        final_turn: finalTurn,
        tool_name: toolCall.name,
      });
      if (toolCall.recovery) {
        notifyProtocol(onProtocolEvent, {
          event: "tool_call_recovered",
          turn: turn + 1,
          final_turn: finalTurn,
          tool_name: toolCall.name,
          recovery: toolCall.recovery,
        });
      }

      if (toolCall.name === "answer") {
        let answerResult;
        try {
          answerResult = await parseAnswer(
            toolCall.args.answer,
            guard,
            boundedResults,
            query,
            budget,
            repoMap,
            executor,
          );
        } catch (error) {
          if (
            error?.protocolReason !== "answer_missing_explicit_no_results"
            || answerFormatRetries >= MAX_ANSWER_FORMAT_RETRIES
          ) throw error;
          answerFormatRetries += 1;
          messages.push({ role: 1, content: answerShapeCorrectionPrompt(boundedResults) });
          let correctionCall;
          try {
            correctionCall = await requestWithFormatCorrection(
              toolDefinitions({ allowRestrictedExec: false }),
              turn + 1,
              true,
            );
          } catch (correctionError) {
            notifyProtocol(onProtocolEvent, {
              event: "answer_correction",
              turn: turn + 1,
              final_turn: true,
              code: typeof correctionError?.code === "string"
                ? correctionError.code
                : "FC_REMOTE_UNAVAILABLE",
              protocol_reason: typeof correctionError?.protocolReason === "string"
                ? correctionError.protocolReason
                : undefined,
            });
            throw correctionError;
          }
          notifyProtocol(onProtocolEvent, {
            event: "answer_correction",
            turn: turn + 1,
            final_turn: true,
            tool_name: correctionCall.name,
          });
          if (correctionCall.name !== "answer") throw protocolError("answer_correction_non_answer");
          const correctedResult = await parseAnswer(
            correctionCall.args.answer,
            guard,
            boundedResults,
            query,
            budget,
            repoMap,
            executor,
          );
          if (correctedResult.projection.remote_candidates === 0) throw error;
          return correctedResult;
        }
        if (
          !canRetryAnswerFormat(answerResult)
          || answerFormatRetries >= MAX_ANSWER_FORMAT_RETRIES
        ) {
          return answerResult;
        }

        answerFormatRetries += 1;
        messages.push({ role: 1, content: answerCorrectionPrompt(answerResult.projection, boundedResults) });
        let correctionCall;
        try {
          correctionCall = await requestWithFormatCorrection(
            toolDefinitions({ allowRestrictedExec: false }),
            turn + 1,
            true,
          );
        } catch (error) {
          notifyProtocol(onProtocolEvent, {
            event: "answer_correction",
            turn: turn + 1,
            final_turn: true,
            code: typeof error?.code === "string" ? error.code : "FC_REMOTE_UNAVAILABLE",
            protocol_reason: typeof error?.protocolReason === "string" ? error.protocolReason : undefined,
          });
          throw error;
        }
        notifyProtocol(onProtocolEvent, {
          event: "answer_correction",
          turn: turn + 1,
          final_turn: true,
          tool_name: correctionCall.name,
        });
        if (correctionCall.name !== "answer") throw protocolError("answer_correction_non_answer");
        const correctedResult = await parseAnswer(
          correctionCall.args.answer,
          guard,
          boundedResults,
          query,
          budget,
          repoMap,
          executor,
        );
        // A correction cannot erase evidence that the previous answer supplied
        // candidates. Keeping that truncated result prevents a false no-results
        // completion when the correction falls back to an empty ANSWER.
        if (
          correctedResult.projection.remote_candidates === 0
          && answerResult.projection.remote_candidates > 0
        ) {
          return answerResult;
        }
        return correctedResult;
      }
      if (finalTurn && toolCall.name === "restricted_exec") {
        throw protocolError("answer_only_restricted_exec");
      }
      if (finalTurn) throw protocolError("answer_only_non_answer");
      if (toolCall.name !== "restricted_exec") throw protocolError("tool_name_invalid");

      observedTurn = turn + 1;
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
      if (turn === MAX_TURNS - 2) {
        messages.push({ role: 1, content: forceAnswerPrompt(boundedResults) });
      }
    }

    throw protocolError("answer_missing_terminal_answer");
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
  timeoutMs = RESOURCE_LIMITS.MAX_ELAPSED_MS,
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
  MAX_TOOL_FORMAT_RETRIES,
  MAX_ANSWER_FORMAT_RETRIES,
  MAX_SESSION_REFRESHES,
  MAX_STREAM_RETRIES,
  MAX_TOOL_ARGS_BYTES,
  MAX_TURNS,
});
