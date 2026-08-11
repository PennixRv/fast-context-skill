import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
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
const CONNECT_USER_AGENT = "connect-go/1.18.1 (go1.25.5)";
const MAX_COMMANDS = EXECUTOR_LIMITS.MAX_COMMANDS;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = CONNECT_LIMITS.MAX_RESPONSE_COMPRESSED_BYTES;
const MAX_TOOL_FORMAT_RETRIES = 1;
const MAX_ANSWER_FORMAT_RETRIES = 1;
const MAX_TOOL_ARGS_BYTES = 16 * 1024;
// Three bounded local-tool rounds plus one answer-only protocol turn.
const MAX_TURNS = 4;

function networkError() {
  return new FastContextError("FC_REMOTE_UNAVAILABLE");
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
      "User-Agent": "connect-go/1.18.1",
    },
    timeoutMs,
    signal,
  );
  const jwt = extractStrings(response).find((value) => value.startsWith("eyJ") && value.includes("."));
  if (!jwt) throw protocolError();
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
      "User-Agent": CONNECT_USER_AGENT,
      "Accept-Encoding": "identity",
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
        description: "Execute only declared filesystem tools in /codebase.",
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
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
  });
  return JSON.stringify(definitions);
}

function systemPrompt(maxResults) {
  return [
    "You are an expert software engineer providing candidate source context for another engineer.",
    "Return files and complete semantic blocks relevant to the requested behavior, including verified implementation and tests when useful.",
    "Use restricted_exec only with /codebase paths.",
    "Never request hidden, credential, generated, or repository metadata paths.",
    "Emit every tool call exactly as [TOOL_CALLS]restricted_exec[ARGS] followed immediately by one JSON object.",
    "Example: [TOOL_CALLS]restricted_exec[ARGS]{\"command1\":{\"type\":\"rg\",\"pattern\":\"symbol\",\"path\":\"/codebase/src\"}}",
    "Each rg needs only pattern and an existing /codebase path; each readfile needs only file, start_line, and end_line. Never send shell text, cwd, or paths outside /codebase.",
    "Use MAP to orient from the repository map, ANCHOR with narrow rg searches, then VERIFY every returned candidate with readfile.",
    "A candidate is not established by a tree or rg hit alone. Include complete relevant functions/classes and direct tests only after verification.",
    "Use all three available restricted_exec rounds before answer unless the local evidence proves there are no relevant files.",
    "Before returning each candidate, use readfile for that exact file and choose a range wholly within the numbered lines returned; never guess line numbers.",
    "After at most three restricted_exec calls, the following turn must return answer using only the locally verified evidence available.",
    "Finish exactly as [TOOL_CALLS]answer[ARGS] followed immediately by one JSON object with an answer field.",
    "Do not add whitespace or prose between [TOOL_CALLS], the tool name, [ARGS], and the JSON object.",
    "The answer field contains an <ANSWER> root with <file path=\"/codebase/relative\"><range>start-end</range></file> entries using positive inclusive ranges based on local tool evidence.",
    "Example: [TOOL_CALLS]answer[ARGS]{\"answer\":\"<ANSWER><file path=\\\"/codebase/src/example.ts\\\"><range>10-20</range></file></ANSWER>\"}",
    "When no relevant candidate exists, return exactly [TOOL_CALLS]answer[ARGS]{\"answer\":\"<ANSWER></ANSWER>\"}.",
    `Return at most ${maxResults} candidate entries and never guess paths or line ranges.`,
  ].join("\n");
}

function forceAnswerPrompt(maxResults) {
  return [
    "You have no tool turns left. Call answer now.",
    "Do not request restricted_exec or any other tool.",
    "Return only locally evidenced candidates inside <ANSWER> as <file path=\"/codebase/relative\"><range>start-end</range></file>.",
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
    "Return every candidate again only when its exact path and inclusive range came from prior readfile output.",
    "Otherwise return exactly <ANSWER></ANSWER>; do not use prose or guess a path or line range.",
    `Return at most ${maxResults} candidate entries.`,
  ].join("\n");
}

function toolFormatCorrectionPrompt(finalTurn) {
  const allowedTool = finalTurn ? "answer" : "restricted_exec or answer";
  return [
    "The previous tool-call envelope was invalid. This is the only tool-format correction attempt.",
    `Call only ${allowedTool} using exactly [TOOL_CALLS]tool_name[ARGS] followed immediately by one valid JSON object.`,
    "Do not add prose, Markdown, XML, or whitespace between the markers and the JSON object.",
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
  if (end < 0) throw retryableToolFormatError();
  const json = source.slice(0, end);
  if (Buffer.byteLength(json, "utf8") > MAX_TOOL_ARGS_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    throw retryableToolFormatError();
  }
  return { name, args };
}

async function requestToolCall(request, fetchImpl, timeoutMs, signal) {
  const response = await streamingRequest(request, fetchImpl, timeoutMs, signal);
  return parseResponse(response);
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
  let rejectedCandidates = 0;
  let unprocessedCandidates = 0;
  const rejectionReasons = new Set();
  let match;
  while ((match = fileExpression.exec(answer)) !== null) {
    matchedFileElements += 1;
    if (candidates.length >= maxResults) {
      unprocessedCandidates += 1;
      continue;
    }
    const range = match[3].match(/<range>([1-9]\d*)-([1-9]\d*)<\/range>/);
    if (!range) {
      rejectedCandidates += 1;
      rejectionReasons.add("remote_candidate_missing_range");
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
      rejectedCandidates += 1;
      rejectionReasons.add(
        budget.snapshot().reasons.includes("candidate_changed")
          ? "remote_candidate_file_changed"
          : "remote_candidate_range_rejected",
      );
      continue;
    }
    if (seen.has(validated.relativePath)) {
      rejectedCandidates += 1;
      rejectionReasons.add("remote_candidate_duplicate");
      continue;
    }
    seen.add(validated.relativePath);
    candidates.push({
      path: validated.relativePath,
      start_line: validated.startLine,
      end_line: validated.endLine,
      reason: "local_range_validated",
    });
  }
  const malformedCandidates = Math.max(0, candidateMarkers.length - matchedFileElements);
  if (malformedCandidates > 0) rejectionReasons.add("remote_candidate_malformed");
  rejectedCandidates += malformedCandidates;
  const coverage = searchCoverage(budget, repoMap, executor);
  return answerResult({
    candidates,
    projection: {
      remote_candidates: candidateMarkers.length,
      accepted_candidates: candidates.length,
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
    const jwt = await fetchJwt(apiKey, fetchImpl, budget.remainingMs(), budget.signal);
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
        content: `Problem statement:\n${query.slice(0, 2000)}\n\nRepository map result:\n${JSON.stringify(repoMap)}`,
      },
    ];
    const definitions = toolDefinitions();
    let toolFormatRetries = 0;
    let answerFormatRetries = 0;

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const finalTurn = turn === MAX_TURNS - 1;
      const request = buildRequest(
        apiKey,
        jwt,
        messages,
        finalTurn ? toolDefinitions({ allowRestrictedExec: false }) : definitions,
      );
      if (request.length > MAX_REQUEST_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
      let toolCall;
      try {
        toolCall = await requestToolCall(
          request,
          fetchImpl,
          budget.remainingMs(),
          budget.signal,
        );
      } catch (error) {
        if (error?.retryableToolFormat && toolFormatRetries < MAX_TOOL_FORMAT_RETRIES) {
          toolFormatRetries += 1;
          messages.push({ role: 1, content: toolFormatCorrectionPrompt(finalTurn) });
          const correctionRequest = buildRequest(
            apiKey,
            jwt,
            messages,
            finalTurn ? toolDefinitions({ allowRestrictedExec: false }) : definitions,
          );
          if (correctionRequest.length > MAX_REQUEST_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
          try {
            toolCall = await requestToolCall(
              correctionRequest,
              fetchImpl,
              budget.remainingMs(),
              budget.signal,
            );
          } catch (correctionError) {
            notifyProtocol(onProtocolEvent, {
              event: "tool_format_correction",
              turn: turn + 1,
              final_turn: finalTurn,
              code: typeof correctionError?.code === "string" ? correctionError.code : "FC_REMOTE_UNAVAILABLE",
              protocol_reason: typeof correctionError?.protocolReason === "string"
                ? correctionError.protocolReason
                : undefined,
            });
            throw correctionError;
          }
          notifyProtocol(onProtocolEvent, {
            event: "tool_format_correction",
            turn: turn + 1,
            final_turn: finalTurn,
            tool_name: toolCall.name,
          });
        } else {
          notifyProtocol(onProtocolEvent, {
            turn: turn + 1,
            final_turn: finalTurn,
            code: typeof error?.code === "string" ? error.code : "FC_REMOTE_UNAVAILABLE",
            protocol_reason: typeof error?.protocolReason === "string" ? error.protocolReason : undefined,
          });
          throw error;
        }
      }
      notifyProtocol(onProtocolEvent, {
        turn: turn + 1,
        final_turn: finalTurn,
        tool_name: toolCall.name,
      });

      if (toolCall.name === "answer") {
        const answerResult = await parseAnswer(
          toolCall.args.answer,
          guard,
          boundedResults,
          query,
          budget,
          repoMap,
          executor,
        );
        if (
          !canRetryAnswerFormat(answerResult)
          || answerFormatRetries >= MAX_ANSWER_FORMAT_RETRIES
        ) {
          return answerResult;
        }

        answerFormatRetries += 1;
        messages.push({ role: 1, content: answerCorrectionPrompt(answerResult.projection, boundedResults) });
        const correctionRequest = buildRequest(
          apiKey,
          jwt,
          messages,
          toolDefinitions({ allowRestrictedExec: false }),
        );
        if (correctionRequest.length > MAX_REQUEST_BYTES) throw new FastContextError("FC_OUTPUT_LIMIT");
        let correctionCall;
        try {
          correctionCall = await requestToolCall(
            correctionRequest,
            fetchImpl,
            budget.remainingMs(),
            budget.signal,
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
  MAX_TOOL_ARGS_BYTES,
  MAX_TURNS,
});
