import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { PathGuard } from "../scripts/lib/path-guard.mjs";
import { search } from "../scripts/lib/core.mjs";
import {
  CONNECT_LIMITS,
  ProtobufEncoder,
  connectFrameEncode,
  extractStrings,
} from "../scripts/lib/protobuf.mjs";

const syntheticKey = "synthetic-key-not-a-real-credential";

function response(body, options = {}) {
  return new Response(body, {
    status: options.status ?? (options.ok === false ? 503 : 200),
    headers: options.headers,
  });
}

function streamedResponse(chunks, options = {}) {
  const state = { arrayBufferCalled: false, cancelled: false, reads: 0 };
  let index = 0;
  let pendingRead;
  const reader = {
    read() {
      state.reads += 1;
      if (index < chunks.length) {
        const value = chunks[index];
        index += 1;
        return Promise.resolve({ done: false, value });
      }
      if (!options.stall) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        pendingRead = resolve;
      });
    },
    async cancel() {
      state.cancelled = true;
      pendingRead?.({ done: true, value: undefined });
    },
    releaseLock() {},
  };
  return {
    state,
    value: {
      ok: true,
      headers: new Headers(options.headers),
      body: { getReader: () => reader },
      async arrayBuffer() {
        state.arrayBufferCalled = true;
        throw new Error("arrayBuffer must not be called");
      },
    },
  };
}

function envelope(payload, flags) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function endStream(value = {}) {
  return envelope(Buffer.from(JSON.stringify(value)), 0x02);
}

function connectResponse(messages, options = {}) {
  const compress = options.compress ?? true;
  return Buffer.concat([
    ...messages.map((message) => connectFrameEncode(message, compress)),
    endStream(options.end),
  ]);
}

function protoString(value) {
  return new ProtobufEncoder().writeString(1, value).toBuffer();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fast-context-core-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "candidate.mjs"), "export const candidate = true;\n");
  return root;
}

function answerFrame(answer = '<file path="/codebase/src/candidate.mjs"><range>1-1</range></file><file path="/tmp/SECRET_SENTINEL"><range>1-2</range></file>') {
  return protoString(
    `[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer })}`,
  );
}

function whitespaceAnswerFrame(answer = '<file path="/codebase/src/candidate.mjs"><range>1-1</range></file>') {
  return protoString(
    `[TOOL_CALLS] answer [ARGS] ${JSON.stringify({ answer })}`,
  );
}

function restrictedExecFrame(commands) {
  return protoString(`[TOOL_CALLS]restricted_exec[ARGS]${JSON.stringify(commands)}`);
}

function fourTreeCommands() {
  return Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
    `command${index + 1}`,
    { type: "tree", path: "/codebase", levels: 1 },
  ]));
}

function decodeRequestFrame(body) {
  assert.equal(body[0], 0x01);
  const length = body.readUInt32BE(1);
  assert.equal(length, body.length - 5);
  return gunzipSync(body.subarray(5));
}

test("search uses injected protocol streams and locally revalidates candidates", async () => {
  const root = fixture();
  const calls = [];
  try {
    const guard = new PathGuard(root);
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
      return response(connectResponse([answerFrame()]), {
        headers: { "Connect-Content-Encoding": "gzip" },
      });
    };
    const result = await search({ query: "find candidate", guard, apiKey: syntheticKey, fetchImpl });
    assert.equal(result.status, "complete");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.candidates, [{
      path: "src/candidate.mjs",
      start_line: 1,
      end_line: 1,
      reason: "local_range_validated",
    }]);
    assert.deepEqual(result.search_terms, ["find", "candidate"]);
    assert.deepEqual(result.coverage.reasons, []);
    assert.ok(result.coverage.visited.entries >= 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers["Accept-Encoding"], "gzip");
    assert.match(calls[0].options.body.toString("utf8"), /synthetic-key/);
    const prompt = extractStrings(decodeRequestFrame(calls[1].options.body)).find((value) => value.includes("[TOOL_CALLS]"));
    assert.match(prompt, /\[TOOL_CALLS\]restricted_exec\[ARGS\]/);
    assert.match(prompt, /at most three restricted_exec calls; the following turn must return answer/);
    assert.match(prompt, /\[TOOL_CALLS\]answer\[ARGS\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing key fails before fetch setup", async () => {
  const root = fixture();
  let fetchCalls = 0;
  try {
    await assert.rejects(
      search({ query: "query", guard: new PathGuard(root), apiKey: "", fetchImpl: async () => { fetchCalls += 1; } }),
      { code: "FC_KEY_MISSING" },
    );
    assert.equal(fetchCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("format-only whitespace around remote tool tags retains strict JSON and local range validation", async () => {
  const root = fixture();
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => url.includes("GetUserJwt")
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([whitespaceAnswerFrame()]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.deepEqual(result.candidates, [{
      path: "src/candidate.mjs",
      start_line: 1,
      end_line: 1,
      reason: "local_range_validated",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one malformed remote tool envelope retries within the shared request budget", async () => {
  const root = fixture();
  let streamCalls = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
        streamCalls += 1;
        return response(connectResponse([
          streamCalls === 1 ? protoString("[TOOL_CALLS] answer [ARGS] not-json") : whitespaceAnswerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCalls, 2);
    assert.deepEqual(result.candidates, [{
      path: "src/candidate.mjs",
      start_line: 1,
      end_line: 1,
      reason: "local_range_validated",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP authentication, server, and transport failures use distinct fixed categories without reading error bodies", async () => {
  const root = fixture();
  try {
    for (const [status, code] of [[401, "FC_AUTH_REJECTED"], [403, "FC_AUTH_REJECTED"], [503, "FC_REMOTE_SERVER_ERROR"]]) {
      let readerRequested = false;
      await assert.rejects(
        search({
          query: "query",
          guard: new PathGuard(root),
          apiKey: syntheticKey,
          fetchImpl: async () => ({
            ok: false,
            status,
            headers: new Headers(),
            body: { getReader() { readerRequested = true; throw new Error("REMOTE_BODY_SENTINEL"); } },
          }),
        }),
        { code },
      );
      assert.equal(readerRequested, false);
    }
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async () => { throw new Error("REMOTE_BODY_SENTINEL"); },
      }),
      { code: "FC_REMOTE_UNAVAILABLE" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful authentication response without a JWT is a protocol error", async () => {
  const root = fixture();
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async () => response(protoString("not-a-jwt")),
      }),
      { code: "FC_PROTOCOL_INVALID" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed remote frames produce a bounded protocol error", async () => {
  const root = fixture();
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(Buffer.from([0, 0, 0, 0, 1, 255])),
      }),
      { code: "FC_PROTOCOL_INVALID" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("response bytes are bounded before arrayBuffer and cancel the reader", async () => {
  const root = fixture();
  const streamed = streamedResponse([
    Buffer.alloc(CONNECT_LIMITS.MAX_RESPONSE_COMPRESSED_BYTES, 65),
    Buffer.from([66]),
  ]);
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : streamed.value,
      }),
      { code: "FC_OUTPUT_LIMIT" },
    );
    assert.equal(streamed.state.arrayBufferCalled, false);
    assert.equal(streamed.state.cancelled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or incorrect Content-Length cannot bypass streaming limits", async () => {
  const root = fixture();
  try {
    for (const headers of [undefined, { "Content-Length": "1" }, { "Content-Length": "invalid" }]) {
      const streamed = streamedResponse([
        Buffer.alloc(CONNECT_LIMITS.MAX_RESPONSE_COMPRESSED_BYTES),
        Buffer.from([1]),
      ], { headers });
      await assert.rejects(
        search({
          query: "query",
          guard: new PathGuard(root),
          apiKey: syntheticKey,
          fetchImpl: async (url) => url.includes("GetUserJwt")
            ? response(protoString("eyJ.synthetic.jwt"))
            : streamed.value,
        }),
        { code: "FC_OUTPUT_LIMIT" },
      );
      assert.equal(streamed.state.cancelled, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized Content-Length rejects before reading the body", async () => {
  const root = fixture();
  const streamed = streamedResponse([], {
    headers: { "Content-Length": String(CONNECT_LIMITS.MAX_RESPONSE_COMPRESSED_BYTES + 1) },
  });
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : streamed.value,
      }),
      { code: "FC_OUTPUT_LIMIT" },
    );
    assert.equal(streamed.state.reads, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gzip expansion beyond the per-frame limit stays an output error", async () => {
  const root = fixture();
  const bomb = connectResponse([
    Buffer.alloc(CONNECT_LIMITS.MAX_FRAME_DECOMPRESSED_BYTES + 1, 65),
  ]);
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(bomb, { headers: { "Connect-Content-Encoding": "gzip" } }),
      }),
      { code: "FC_OUTPUT_LIMIT" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slow response streams converge on a dedicated timeout category and cancel the reader", async () => {
  const root = fixture();
  const streamed = streamedResponse([], { stall: true });
  const started = performance.now();
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        timeoutMs: 25,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : streamed.value,
      }),
      { code: "FC_REMOTE_TIMEOUT" },
    );
    assert.equal(streamed.state.cancelled, true);
    assert.ok(performance.now() - started < 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caller cancellation interrupts a response after partial delivery", async () => {
  const root = fixture();
  const controller = new AbortController();
  const streamed = streamedResponse([Buffer.from([0, 0, 0, 0, 1, 65])], { stall: true });
  try {
    const pending = search({
      query: "query",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      signal: controller.signal,
      fetchImpl: async (url) => url.includes("GetUserJwt")
        ? response(protoString("eyJ.synthetic.jwt"))
        : streamed.value,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { code: "FC_REMOTE_UNAVAILABLE" });
    assert.equal(streamed.state.cancelled, true);
    assert.equal(streamed.state.reads, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote EndStream errors never produce successful candidates", async () => {
  const root = fixture();
  const body = Buffer.concat([
    connectFrameEncode(answerFrame(), false),
    endStream({ error: { code: "unavailable", message: "REMOTE_BODY_SENTINEL" } }),
  ]);
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(body),
      }),
      { code: "FC_PROTOCOL_INVALID" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-map truncation remains explicit in the public result", async () => {
  const root = fixture();
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      resourceLimits: { MAX_VISITED_ENTRIES: 1 },
      fetchImpl: async (url) => url.includes("GetUserJwt")
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame()]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "truncated");
    assert.equal(result.truncated, true);
    assert.deepEqual(result.coverage.reasons, ["entry_limit"]);
    assert.ok(result.coverage.continuation);
    assert.equal(result.candidates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote ranges are dropped on EOF, empty files, and span while valid final lines remain", async () => {
  const root = fixture();
  writeFileSync(join(root, "start-over.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "end-over.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "long.txt"), Array.from({ length: 201 }, (_, index) => `line-${index + 1}`).join("\n"));
  writeFileSync(join(root, "valid-tail.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "valid-no-tail.txt"), "one\ntwo\nthree");
  const answer = [
    '<file path="/codebase/start-over.txt"><range>4-4</range></file>',
    '<file path="/codebase/end-over.txt"><range>2-4</range></file>',
    '<file path="/codebase/empty.txt"><range>1-1</range></file>',
    '<file path="/codebase/long.txt"><range>1-201</range></file>',
    '<file path="/codebase/valid-tail.txt"><range>3-3</range><reason>REMOTE_SENTINEL</reason></file>',
    '<file path="/codebase/valid-no-tail.txt"><range>3-3</range></file>',
  ].join("");
  try {
    const result = await search({
      query: "validate ranges",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => url.includes("GetUserJwt")
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(answer)]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates, [
      { path: "valid-tail.txt", start_line: 3, end_line: 3, reason: "local_range_validated" },
      { path: "valid-no-tail.txt", start_line: 3, end_line: 3, reason: "local_range_validated" },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /REMOTE_SENTINEL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file changed during range validation degrades to a local truncated result", async () => {
  const root = fixture();
  try {
    const guard = new PathGuard(root);
    const buildRepoMap = guard.buildRepoMap.bind(guard);
    guard.buildRepoMap = async (budget) => {
      const result = await buildRepoMap(budget);
      const resolveExistingAsync = guard.resolveExistingAsync.bind(guard);
      let candidateResolutions = 0;
      guard.resolveExistingAsync = async (...args) => {
        if (args[0] === "/codebase/src/candidate.mjs") {
          candidateResolutions += 1;
          if (candidateResolutions === 2) {
            writeFileSync(join(root, "src", "candidate.mjs"), "changed\nwith\nmore\nlines\n");
          }
        }
        return resolveExistingAsync(...args);
      };
      return result;
    };
    const result = await search({
      query: "changing candidate",
      guard,
      apiKey: syntheticKey,
      fetchImpl: async (url) => url.includes("GetUserJwt")
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame()]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "truncated");
    assert.equal(result.truncated, true);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.coverage.reasons, ["candidate_changed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("typed local tool results are carried into the next protocol request", async () => {
  const root = fixture();
  const requestFrames = [];
  let streamCall = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
        requestFrames.push(decodeRequestFrame(options.body));
        streamCall += 1;
        return response(connectResponse([
          streamCall === 1
            ? restrictedExecFrame({ command1: { type: "tree", path: "/codebase", levels: 1 } })
            : answerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(requestFrames.length, 2);
    assert.equal(requestFrames[1].includes(Buffer.from('"status":"complete"')), true);
    assert.equal(requestFrames[1].includes(Buffer.from('"visited"')), true);
    assert.equal(requestFrames[1].includes(Buffer.from("restricted local tool request accepted")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the final protocol turn declares answer only after three bounded local-tool rounds", async () => {
  const root = fixture();
  const requestFrames = [];
  let streamCall = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
        requestFrames.push(decodeRequestFrame(options.body));
        streamCall += 1;
        return response(connectResponse([
          streamCall <= 3
            ? restrictedExecFrame({ command1: { type: "tree", path: "/codebase", levels: 1 } })
            : answerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(requestFrames.length, 4);
    const terminalDefinitions = extractStrings(requestFrames[3])
      .find((value) => value.includes('"type":"function"') && value.includes('"name":"answer"'));
    assert.ok(terminalDefinitions);
    assert.equal(terminalDefinitions.includes('restricted_exec'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("three four-command local-tool rounds and the answer-only turn consume one decreasing deadline", async () => {
  let now = 0;
  let streamCalls = 0;
  let toolCalls = 0;
  const observedTimeouts = [];
  const guard = {
    root: "/unused",
    async validateCandidateRange() {
      return null;
    },
    async buildRepoMap(budget) {
      return {
        status: "complete",
        output: "/codebase",
        visited: budget.snapshot().visited,
        continuation: null,
        reason: null,
      };
    },
    async tree(_path, _levels, budget) {
      toolCalls += 1;
      now += 15;
      budget.assertActive();
      budget.tryConsume("directories", 1, "directory_limit");
      const output = "/codebase";
      budget.tryConsume("outputBytes", Buffer.byteLength(output), "output_limit");
      return {
        status: "complete",
        output,
        visited: budget.snapshot().visited,
        continuation: null,
        reason: null,
      };
    },
  };
  const started = performance.now();
  await assert.rejects(
    search({
      query: "bounded rounds",
      guard,
      apiKey: syntheticKey,
      timeoutMs: 1_000,
      now: () => now,
      fetchImpl: async (url, options) => {
        now += 10;
        if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
        observedTimeouts.push(Number(options.headers["Connect-Timeout-Ms"]));
        streamCalls += 1;
        return response(connectResponse([restrictedExecFrame(fourTreeCommands())]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    }),
    { code: "FC_PROTOCOL_INVALID" },
  );
  assert.equal(streamCalls, 4);
  assert.equal(toolCalls, 12);
  assert.equal(observedTimeouts.length, 4);
  assert.ok(observedTimeouts[0] > observedTimeouts[1]);
  assert.ok(observedTimeouts[1] > observedTimeouts[2]);
  assert.ok(observedTimeouts[2] > observedTimeouts[3]);
  assert.ok(performance.now() - started < 500);
});

test("a local deadline stops the active command round without a fresh timeout", async () => {
  let now = 0;
  let fetchCalls = 0;
  let toolCalls = 0;
  const guard = {
    root: "/unused",
    async validateCandidateRange() {
      return null;
    },
    async buildRepoMap(budget) {
      return {
        status: "complete",
        output: "/codebase",
        visited: budget.snapshot().visited,
        continuation: null,
        reason: null,
      };
    },
    async tree(_path, _levels, budget) {
      toolCalls += 1;
      now += 60;
      budget.assertActive();
      return {
        status: "complete",
        output: "/codebase",
        visited: budget.snapshot().visited,
        continuation: null,
        reason: null,
      };
    },
  };
  const started = performance.now();
  await assert.rejects(
    search({
      query: "local timeout",
      guard,
      apiKey: syntheticKey,
      timeoutMs: 100,
      now: () => now,
      fetchImpl: async (url) => {
        fetchCalls += 1;
        now += 5;
        return url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(connectResponse([restrictedExecFrame(fourTreeCommands())]), {
            headers: { "Connect-Content-Encoding": "gzip" },
          });
      },
    }),
    { code: "FC_REMOTE_UNAVAILABLE" },
  );
  assert.equal(fetchCalls, 2);
  assert.equal(toolCalls, 2);
  assert.ok(performance.now() - started < 500);
});
