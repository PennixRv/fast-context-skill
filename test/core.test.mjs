import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const ledgerFixtureDirectory = join(fixtureDirectory, "fixtures", "ledger-recall");

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
  let resolveFirstRead;
  const firstRead = new Promise((resolve) => { resolveFirstRead = resolve; });
  const reader = {
    read() {
      state.reads += 1;
      if (state.reads === 1) resolveFirstRead();
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
    firstRead,
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

async function waitForFirstRead(streamed, timeoutMs = 100) {
  let timer;
  try {
    await Promise.race([
      streamed.firstRead,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("stream did not begin")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

function ledgerFixture() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "fast-context-ledger-"));
  const root = join(temporaryRoot, "project");
  cpSync(ledgerFixtureDirectory, root, { recursive: true });
  return { root, temporaryRoot };
}

function answerFrame(answer = '<file path="/codebase/src/candidate.mjs"><range>1-1</range></file>', options = {}) {
  return protoString(
    `${options.prefix || ""}[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer })}${options.suffix || ""}`,
  );
}

function whitespaceAnswerFrame(answer = '<file path="/codebase/src/candidate.mjs"><range>1-1</range></file>') {
  return protoString(
    `[TOOL_CALLS] answer [ARGS] ${JSON.stringify({ answer })}`,
  );
}

function restrictedExecFrame(commands, options = {}) {
  return protoString(
    `${options.prefix || ""}[TOOL_CALLS]restricted_exec[ARGS]${JSON.stringify(commands)}${options.suffix || ""}`,
  );
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

test("search preflights the upstream model route and locally revalidates candidates", async () => {
  const root = fixture();
  const calls = [];
  try {
    const guard = new PathGuard(root);
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
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
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.headers["Accept-Encoding"], "gzip");
    assert.equal(calls[0].options.headers["User-Agent"], "connect-go/1.18.1 (go1.25.5)");
    assert.match(calls[1].url, /CheckUserMessageRateLimit$/);
    assert.equal(calls[1].options.headers["Accept-Encoding"], "gzip");
    assert.equal(calls[1].options.headers["Content-Encoding"], "gzip");
    assert.equal(calls[1].options.headers["User-Agent"], "connect-go/1.18.1 (go1.25.5)");
    const preflightRequest = gunzipSync(calls[1].options.body);
    assert.equal(preflightRequest.includes(Buffer.from("MODEL_SWE_1_6_FAST")), true);
    assert.equal(preflightRequest.includes(Buffer.from('"Release":"0"')), true);
    assert.equal(preflightRequest.includes(Buffer.from('"ProductVersion":"0"')), true);
    assert.equal(preflightRequest.includes(Buffer.from('"Nodename":""')), true);
    assert.equal(preflightRequest.includes(Buffer.from('"Memory":0')), true);
    assert.equal(calls[2].options.headers["Accept-Encoding"], "identity");
    assert.equal(calls[2].options.headers["User-Agent"], "connect-go/1.18.1 (go1.25.5)");
    assert.equal(Object.hasOwn(calls[2].options.headers, "X-Request-Id"), false);
    assert.match(calls[0].options.body.toString("utf8"), /synthetic-key/);
    const prompt = extractStrings(decodeRequestFrame(calls[2].options.body)).find((value) => value.includes("[TOOL_CALLS]"));
    assert.match(prompt, /\[TOOL_CALLS\]restricted_exec\[ARGS\]/);
    assert.match(prompt, /Use no more than three restricted_exec rounds/);
    assert.match(prompt, /never request another tool turn solely to use a remaining round/);
    assert.match(prompt, /readfile returns numbered rows as N:source and a locally generated read_range/);
    assert.match(prompt, /Never send shell text, cwd, paths outside \/codebase/);
    assert.match(prompt, /Use MAP to orient from the repository map, ANCHOR with narrow rg searches/);
    assert.match(prompt, /Read the implementation before its test/);
    assert.match(prompt, /Never return a test as the only candidate/);
    assert.match(prompt, /next restricted_exec call must reserve at least one command for readfile/);
    assert.match(prompt, /one to four command1 through command4 properties/);
    assert.match(prompt, /Think step-by-step before each tool request/);
    assert.match(prompt, /client discards all text outside it/);
    assert.match(prompt, /\[TOOL_CALLS\]answer\[ARGS\]/);
    const initialRequest = decodeRequestFrame(calls[2].options.body);
    assert.equal(initialRequest.includes(Buffer.from("Problem Statement: find candidate")), true);
    assert.equal(initialRequest.includes(Buffer.from(
      "Repo Map (bounded local tree rooted at /codebase; status: complete):\n```text",
    )), true);
    assert.equal(initialRequest.includes(Buffer.from(
      "Verify every candidate path and range with restricted_exec before answering",
    )), true);
    assert.equal(initialRequest.includes(Buffer.from('"visited"')), false);
    assert.equal(initialRequest.includes(Buffer.from('"continuation"')), false);
    assert.equal(initialRequest.includes(Buffer.from('"output"')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rate-limit preflight fails closed before repository mapping or streaming", async () => {
  const root = fixture();
  let mapCalls = 0;
  let streamCalls = 0;
  const protocolEvents = [];
  try {
    const guard = new PathGuard(root);
    const buildRepoMap = guard.buildRepoMap.bind(guard);
    guard.buildRepoMap = async (...args) => {
      mapCalls += 1;
      return buildRepoMap(...args);
    };
    await assert.rejects(
      search({
        query: "find candidate",
        guard,
        apiKey: syntheticKey,
        onProtocolEvent(event) { protocolEvents.push(event); },
        fetchImpl: async (url) => {
          if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
          if (url.includes("CheckUserMessageRateLimit")) {
            return response(Buffer.from("REMOTE_BODY_SENTINEL"), { status: 429 });
          }
          streamCalls += 1;
          return response(connectResponse([answerFrame()]));
        },
      }),
      { code: "FC_REMOTE_UNAVAILABLE" },
    );
    assert.equal(mapCalls, 0);
    assert.equal(streamCalls, 0);
    assert.deepEqual(protocolEvents, [
      { event: "rate_limit_preflight", status: "started" },
      {
        event: "rate_limit_preflight",
        status: "failed",
        code: "FC_REMOTE_UNAVAILABLE",
        protocol_reason: "http_rate_limited",
      },
    ]);
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
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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
  const requests = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
        requests.push(decodeRequestFrame(options.body));
        streamCalls += 1;
        return response(connectResponse([
          streamCalls === 1 ? protoString("[TOOL_CALLS] answer [ARGS] not-json") : whitespaceAnswerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCalls, 2);
    const correctionStrings = extractStrings(requests[1]);
    assert.ok(correctionStrings.some((value) => value.includes("previous tool-call envelope was invalid")));
    assert.ok(correctionStrings.some((value) => value.includes("only tool-format correction attempt")));
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

test("separate executable turns each retain one bounded format correction", async () => {
  const root = fixture();
  const requests = [];
  let streamCalls = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        requests.push(decodeRequestFrame(options.body));
        streamCalls += 1;
        const frame = streamCalls === 1 || streamCalls === 3
          ? protoString("[TOOL_CALLS] restricted_exec [ARGS] not-json")
          : streamCalls === 2
            ? restrictedExecFrame({ command1: { type: "tree", path: "/codebase", levels: 1 } })
            : streamCalls === 4
              ? restrictedExecFrame({
                command1: {
                  type: "readfile",
                  file: "/codebase/src/candidate.mjs",
                  start_line: 1,
                  end_line: 1,
                },
              })
              : answerFrame();
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 5);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    for (const index of [1, 3]) {
      const strings = extractStrings(requests[index]);
      assert.ok(strings.some((value) => value.includes("only tool-format correction attempt for this request")));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second malformed envelope in one turn still fails closed", async () => {
  const root = fixture();
  let streamCalls = 0;
  try {
    await assert.rejects(
      search({
        query: "find candidate",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => {
          if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
            return response(protoString("eyJ.synthetic.jwt"));
          }
          streamCalls += 1;
          return response(connectResponse([
            protoString("[TOOL_CALLS] restricted_exec [ARGS] not-json"),
          ]), { headers: { "Connect-Content-Encoding": "gzip" } });
        },
      }),
      (error) => error?.code === "FC_PROTOCOL_INVALID"
        && error?.protocolReason === "tool_call_format_invalid",
    );
    assert.equal(streamCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("common malformed restricted_exec JSON is repaired inside the bounded envelope", async () => {
  const root = fixture();
  let streamCalls = 0;
  const protocolEvents = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? protoString(
            '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/src/candidate.mjs","start_line":1,"end_line":1},command2":{"type":"tree","path":"/codebase","levels":1},}',
          )
          : answerFrame();
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    assert.ok(protocolEvents.some((event) => event.event === "tool_call_recovered"
      && event.recovery === "json_repaired"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete restricted_exec commands are salvaged from a truncated tool object", async () => {
  const root = fixture();
  let streamCalls = 0;
  const protocolEvents = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? protoString(
            '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/src/candidate.mjs","start_line":1,"end_line":1},"command2":{"type":"rg","pattern":"unterminated"',
          )
          : answerFrame();
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    assert.ok(protocolEvents.some((event) => event.event === "tool_call_recovered"
      && event.recovery === "commands_salvaged"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested command-like text is not salvaged as a top-level restricted command", async () => {
  const root = fixture();
  let streamCalls = 0;
  const protocolEvents = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? protoString(
            '[TOOL_CALLS]restricted_exec[ARGS]{"wrapper":{"command1":{"type":"readfile","file":"/codebase/src/candidate.mjs","start_line":1,"end_line":1}}',
          )
          : answerFrame();
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    assert.ok(protocolEvents.some((event) => event.event === "tool_format_correction"));
    assert.equal(protocolEvents.some((event) => event.event === "local_tool"), false);
    assert.equal(protocolEvents.some((event) => event.event === "tool_call_recovered"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete top-level answer string survives a truncated outer JSON object", async () => {
  const root = fixture();
  const protocolEvents = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        return response(connectResponse([protoString(
          '[TOOL_CALLS]answer[ARGS]{"answer":"<ANSWER><file path=\\"/codebase/src/candidate.mjs\\"><range>1-1</range></file></ANSWER>"',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    assert.ok(protocolEvents.some((event) => event.event === "tool_call_recovered"
      && event.recovery === "answer_salvaged"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repaired unquoted answer key can still salvage one complete truncated string", async () => {
  const root = fixture();
  const protocolEvents = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        return response(connectResponse([protoString(
          '[TOOL_CALLS]answer[ARGS]{answer:"<ANSWER><file path=\\"/codebase/src/candidate.mjs\\"><range>1-1</range></file></ANSWER>"',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    assert.ok(protocolEvents.some((event) => event.event === "tool_call_recovered"
      && event.recovery === "answer_salvaged"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trailing tool text receives one bounded correction and is never replayed", async () => {
  const root = fixture();
  let streamCalls = 0;
  const requests = [];
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
        requests.push(decodeRequestFrame(options.body));
        streamCalls += 1;
        return response(connectResponse([
          streamCalls === 1
            ? answerFrame(undefined, { suffix: " REMOTE_TRAILING_SENTINEL" })
            : answerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "complete");
    assert.equal(extractStrings(requests[1]).some((value) => value.includes("REMOTE_TRAILING_SENTINEL")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("answer-only format correction remains available after an executable-turn correction", async () => {
  const root = fixture();
  const requests = [];
  let streamCalls = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        requests.push(decodeRequestFrame(options.body));
        const responseFrame = streamCalls === 1 || streamCalls === 5
          ? protoString("[TOOL_CALLS] answer [ARGS] not-json")
          : streamCalls === 6
            ? answerFrame()
            : restrictedExecFrame({ command1: { type: "tree", path: "/codebase", levels: 1 } });
        return response(connectResponse([responseFrame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 6);
    assert.deepEqual(result.candidates, [{
      path: "src/candidate.mjs",
      start_line: 1,
      end_line: 1,
      reason: "local_range_validated",
    }]);
    const terminalCorrection = extractStrings(requests[5]);
    assert.ok(terminalCorrection.some((value) => value.includes("only tool-format correction attempt")));
    assert.ok(terminalCorrection.some((value) => value.includes("This is answer-only")));
    const terminalDefinitions = terminalCorrection
      .find((value) => value.includes('"type":"function"') && value.includes('"name":"answer"'));
    assert.ok(terminalDefinitions);
    assert.equal(terminalDefinitions.includes("restricted_exec"), false);
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
  const protocolEvents = [];
  try {
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        onProtocolEvent(event) { protocolEvents.push(event); },
        fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(Buffer.from([0, 0, 0, 0, 1, 255])),
      }),
      { code: "FC_PROTOCOL_INVALID" },
    );
    assert.equal(protocolEvents.at(-1)?.protocol_reason, "connect_end_stream_missing");
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
        fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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
          fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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
        fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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
        fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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
        fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : streamed.value,
    });
    await waitForFirstRead(streamed);
    controller.abort();
    await assert.rejects(pending, { code: "FC_REMOTE_UNAVAILABLE" });
    assert.equal(streamed.state.cancelled, true);
    assert.ok(streamed.state.reads >= 1);
    assert.ok(streamed.state.reads <= 2);
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
        fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(body),
      }),
      (error) => error?.code === "FC_REMOTE_UNAVAILABLE"
        && error?.protocolReason === "connect_end_stream_unavailable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transient remote capacity rejection retries the same bounded stream request", async () => {
  const root = fixture();
  const protocolEvents = [];
  let streamCalls = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      waitImpl: async () => {},
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        return response(connectResponse(
          streamCalls === 1
            ? []
            : [answerFrame()],
          streamCalls === 1
            ? { end: { error: { code: "resource_exhausted", message: "REMOTE_BODY_SENTINEL" } } }
            : undefined,
        ), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCalls, 2);
    assert.deepEqual(result.candidates, [{
      path: "src/candidate.mjs",
      start_line: 1,
      end_line: 1,
      reason: "local_range_validated",
    }]);
    assert.deepEqual(protocolEvents, [
      { event: "rate_limit_preflight", status: "started" },
      { event: "rate_limit_preflight", status: "complete" },
      {
        event: "stream_retry",
        attempt: 1,
        code: "FC_REMOTE_UNAVAILABLE",
        protocol_reason: "connect_end_stream_resource_exhausted",
        turn: 1,
        final_turn: false,
      },
      { turn: 1, final_turn: false, tool_name: "answer" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent stream capacity rejection refreshes the bounded session once", async () => {
  const root = fixture();
  const protocolEvents = [];
  let jwtCalls = 0;
  let preflightCalls = 0;
  let streamCalls = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      waitImpl: async () => {},
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt")) {
          jwtCalls += 1;
          return response(protoString(`eyJ.synthetic.jwt.${jwtCalls}`));
        }
        if (url.includes("CheckUserMessageRateLimit")) {
          preflightCalls += 1;
          return response(protoString("available"));
        }
        streamCalls += 1;
        return response(connectResponse(
          streamCalls <= 3 ? [] : [answerFrame()],
          streamCalls <= 3
            ? { end: { error: { code: "resource_exhausted", message: "REMOTE_BODY_SENTINEL" } } }
            : undefined,
        ), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(jwtCalls, 2);
    assert.equal(preflightCalls, 2);
    assert.equal(streamCalls, 4);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/candidate.mjs"]);
    assert.deepEqual(protocolEvents.filter((event) => event.event === "session_refresh"), [
      { event: "session_refresh", status: "started", attempt: 1, turn: 1, final_turn: false },
      { event: "session_refresh", status: "complete", attempt: 1, turn: 1, final_turn: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent stream capacity rejection stops after two bounded session refreshes", async () => {
  const root = fixture();
  const protocolEvents = [];
  let jwtCalls = 0;
  let preflightCalls = 0;
  let streamCalls = 0;
  try {
    await assert.rejects(search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      waitImpl: async () => {},
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt")) {
          jwtCalls += 1;
          return response(protoString(`eyJ.synthetic.jwt.${jwtCalls}`));
        }
        if (url.includes("CheckUserMessageRateLimit")) {
          preflightCalls += 1;
          return response(protoString("available"));
        }
        streamCalls += 1;
        return response(connectResponse([], {
          end: { error: { code: "resource_exhausted", message: "REMOTE_BODY_SENTINEL" } },
        }), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    }), (error) => error?.code === "FC_REMOTE_UNAVAILABLE");
    assert.equal(jwtCalls, 3);
    assert.equal(preflightCalls, 3);
    assert.equal(streamCalls, 9);
    assert.deepEqual(protocolEvents.filter((event) => event.event === "session_refresh"), [
      { event: "session_refresh", status: "started", attempt: 1, turn: 1, final_turn: false },
      { event: "session_refresh", status: "complete", attempt: 1, turn: 1, final_turn: false },
      { event: "session_refresh", status: "started", attempt: 2, turn: 1, final_turn: false },
      { event: "session_refresh", status: "complete", attempt: 2, turn: 1, final_turn: false },
    ]);
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
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
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

test("invalid remote ranges are visible as incomplete while valid final lines remain", async () => {
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
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(answer)]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "truncated");
    assert.equal(result.truncated, true);
    assert.deepEqual(result.candidates, [
      { path: "valid-tail.txt", start_line: 3, end_line: 3, reason: "local_range_validated" },
      { path: "valid-no-tail.txt", start_line: 3, end_line: 3, reason: "local_range_validated" },
    ]);
    assert.deepEqual(result.projection, {
      remote_candidates: 6,
      accepted_candidates: 2,
      recovered_candidates: 0,
      rejected_candidates: 4,
      unprocessed_candidates: 0,
      rejection_reasons: ["remote_candidate_range_rejected"],
    });
    assert.ok(result.coverage.reasons.includes("remote_candidate_projection_rejected"));
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
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame()]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "truncated");
    assert.equal(result.truncated, true);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.coverage.reasons, ["candidate_changed", "remote_candidate_projection_rejected"]);
    assert.equal(result.projection.rejected_candidates, 1);
    assert.deepEqual(result.projection.rejection_reasons, ["remote_candidate_file_changed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sufficient local evidence may answer without consuming remaining tool rounds", async () => {
  const root = fixture();
  const requestFrames = [];
  let streamCall = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
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
    const secondRequestStrings = extractStrings(requestFrames[1]);
    assert.equal(secondRequestStrings.some((value) => value.includes("You have no tool turns left")), false);
    const secondDefinitions = secondRequestStrings
      .find((value) => value.includes('"type":"function"') && value.includes('"name":"answer"'));
    assert.ok(secondDefinitions?.includes("restricted_exec"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locally generated read ranges are carried into the next protocol request", async () => {
  const root = fixture();
  const requestFrames = [];
  let streamCall = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        requestFrames.push(decodeRequestFrame(options.body));
        streamCall += 1;
        return response(connectResponse([
          streamCall === 1
            ? restrictedExecFrame({
              command1: {
                type: "readfile",
                file: "/codebase/src/candidate.mjs",
                start_line: 1,
                end_line: 80,
              },
            })
            : answerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCall, 2);
    assert.equal(requestFrames[1].includes(Buffer.from(
      '"read_range":{"start_line":1,"end_line":1}',
    )), true);
    assert.equal(requestFrames[1].includes(Buffer.from(
      '"read_range":{"start_line":1,"end_line":2}',
    )), false);
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

test("ledger read ranges exclude trailing newline sentinels before candidate projection", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  const requestFrames = [];
  let streamCall = 0;
  try {
    const result = await search({
      query: "find the orphaned settlement repair implementation",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        requestFrames.push(decodeRequestFrame(options.body));
        streamCall += 1;
        return response(connectResponse([
          streamCall === 1
            ? restrictedExecFrame({
              command1: {
                type: "readfile",
                file: "/codebase/src/ledger/repair.ts",
                start_line: 1,
                end_line: 80,
              },
              command2: {
                type: "readfile",
                file: "/codebase/test/ledger-repair.test.ts",
                start_line: 1,
                end_line: 80,
              },
            })
            : answerFrame(
              '<ANSWER><file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>'
                + '<file path="/codebase/test/ledger-repair.test.ts"><range>1-11</range></file></ANSWER>',
            ),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCall, 2);
    assert.equal(requestFrames[1].includes(Buffer.from(
      '"read_range":{"start_line":1,"end_line":24}',
    )), true);
    assert.equal(requestFrames[1].includes(Buffer.from(
      '"read_range":{"start_line":1,"end_line":11}',
    )), true);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      "src/ledger/repair.ts",
      "test/ledger-repair.test.ts",
    ]);
    assert.equal(result.status, "complete");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
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
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
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
    const terminalMessages = extractStrings(requestFrames[3]);
    assert.ok(terminalMessages.some((value) => value.includes("You have no tool turns left")));
    assert.ok(terminalMessages.some((value) => value.includes("Your entire response must be exactly [TOOL_CALLS]answer[ARGS]")));
    assert.ok(terminalMessages.some((value) => value.includes("prior readfile read_range")));
    assert.ok(terminalMessages.some((value) => value.includes("<ANSWER></ANSWER>")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool-envelope prefix is discarded and never replayed to the remote service", async () => {
  const root = fixture();
  const requests = [];
  let streamCalls = 0;
  try {
    const result = await search({
      query: "find candidate",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
        requests.push(decodeRequestFrame(options.body));
        streamCalls += 1;
        return response(connectResponse([
          streamCalls === 1
            ? restrictedExecFrame(
              { command1: { type: "tree", path: "/codebase", levels: 1 } },
              { prefix: "REMOTE_THINKING_SENTINEL\\n" },
            )
            : answerFrame(),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(streamCalls, 2);
    assert.equal(extractStrings(requests[1]).some((value) => value.includes("REMOTE_THINKING_SENTINEL")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal restricted_exec has a stable non-sensitive protocol reason", async () => {
  const root = fixture();
  let streamCall = 0;
  const protocolEvents = [];
  try {
    await assert.rejects(
      search({
        query: "find candidate",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        onProtocolEvent(event) { protocolEvents.push(event); },
        fetchImpl: async (url) => {
          if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
          streamCall += 1;
          return response(connectResponse([
            restrictedExecFrame({ command1: { type: "tree", path: "/codebase", levels: 1 } }),
          ]), { headers: { "Connect-Content-Encoding": "gzip" } });
        },
      }),
      (error) => error?.code === "FC_PROTOCOL_INVALID"
        && error?.protocolReason === "answer_only_restricted_exec"
        && !String(error.message).includes("restricted local tool request accepted"),
    );
    assert.equal(streamCall, 4);
    assert.deepEqual(protocolEvents.at(-1), {
      turn: 4,
      final_turn: true,
      tool_name: "restricted_exec",
    });
    assert.ok(protocolEvents.some((event) => event.event === "local_tool"
      && event.command_type === "tree"
      && event.status === "complete"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the controlled ledger fixture projects a locally valid candidate", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "complete");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.candidates, [{
      path: "src/ledger/repair.ts",
      start_line: 1,
      end_line: 24,
      reason: "local_range_validated",
    }]);
    assert.deepEqual(result.projection, {
      remote_candidates: 1,
      accepted_candidates: 1,
      recovered_candidates: 0,
      rejected_candidates: 0,
      unprocessed_candidates: 0,
      rejection_reasons: [],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a single file may carry multiple locally validated candidate ranges", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<ANSWER><file path="/codebase/src/ledger/repair.ts"><range>1-12</range><range>13-24</range></file></ANSWER>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates, [
      {
        path: "src/ledger/repair.ts",
        start_line: 1,
        end_line: 12,
        reason: "local_range_validated",
      },
      {
        path: "src/ledger/repair.ts",
        start_line: 13,
        end_line: 24,
        reason: "local_range_validated",
      },
    ]);
    assert.deepEqual(result.projection, {
      remote_candidates: 2,
      accepted_candidates: 2,
      recovered_candidates: 0,
      rejected_candidates: 0,
      unprocessed_candidates: 0,
      rejection_reasons: [],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an answer candidate without a range is not reported as complete no-results", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<file path="/codebase/test/ledger-repair.test.ts"></file>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "truncated");
    assert.equal(result.truncated, true);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.projection, {
      remote_candidates: 1,
      accepted_candidates: 0,
      recovered_candidates: 0,
      rejected_candidates: 1,
      unprocessed_candidates: 0,
      rejection_reasons: ["remote_candidate_missing_range"],
    });
    assert.deepEqual(result.coverage.reasons, ["remote_candidate_projection_rejected"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("one answer-format correction uses answer only and returns a locally valid range", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  const requests = [];
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
        requests.push(decodeRequestFrame(options.body));
        streamCalls += 1;
        const answer = streamCalls === 1
          ? '<ANSWER><file path="/codebase/src/ledger/repair.ts"></file></ANSWER>'
          : '<ANSWER><file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file></ANSWER>';
        return response(connectResponse([answerFrame(answer)]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/ledger/repair.ts"]);
    const correctionDefinitions = extractStrings(requests[1])
      .find((value) => value.includes('"type":"function"') && value.includes('"name":"answer"'));
    assert.ok(correctionDefinitions);
    assert.equal(correctionDefinitions.includes("restricted_exec"), false);
    const correctionMessages = extractStrings(requests[1]);
    assert.ok(correctionMessages.some((value) => value.includes("only answer-format correction attempt")));
    assert.ok(correctionMessages.some((value) => value.includes("remote_candidate_missing_range")));
    assert.ok(correctionMessages.some((value) => value.includes("copied from a prior readfile read_range")));
    assert.equal(correctionMessages.some((value) => value.includes("src/ledger/repair.ts")), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an answer correction request retains one bounded envelope correction", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  const requests = [];
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url, options) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        requests.push(decodeRequestFrame(options.body));
        streamCalls += 1;
        const frame = streamCalls === 1
          ? answerFrame('<ANSWER><file path="/codebase/src/ledger/repair.ts"></file></ANSWER>')
          : streamCalls === 2
            ? protoString("[TOOL_CALLS] answer [ARGS] not-json")
            : answerFrame('<ANSWER><file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file></ANSWER>');
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 3);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/ledger/repair.ts"]);
    const formatCorrection = extractStrings(requests[2]);
    assert.ok(formatCorrection.some((value) => value.includes("only tool-format correction attempt for this request")));
    const definitions = formatCorrection
      .find((value) => value.includes('"type":"function"') && value.includes('"name":"answer"'));
    assert.ok(definitions);
    assert.equal(definitions.includes("restricted_exec"), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a second rejected answer does not create an unbounded correction loop", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
        streamCalls += 1;
        return response(connectResponse([answerFrame(
          '<ANSWER><file path="/codebase/src/ledger/repair.ts"></file></ANSWER>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.equal(result.projection.rejected_candidates, 1);
    assert.deepEqual(result.projection.rejection_reasons, ["remote_candidate_missing_range"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an empty correction cannot downgrade rejected remote candidates to complete no-results", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
        streamCalls += 1;
        const answer = streamCalls === 1
          ? '<ANSWER><file path="/codebase/src/ledger/repair.ts"></file></ANSWER>'
          : "<ANSWER></ANSWER>";
        return response(connectResponse([answerFrame(answer)]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.equal(result.candidates.length, 0);
    assert.equal(result.projection.remote_candidates, 1);
    assert.equal(result.projection.rejected_candidates, 1);
    assert.deepEqual(result.projection.rejection_reasons, ["remote_candidate_missing_range"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("all PathGuard-rejected candidates remain visibly incomplete", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root, ["src/**"]),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.projection.rejected_candidates, 1);
    assert.deepEqual(result.projection.rejection_reasons, ["remote_candidate_path_rejected"]);
    assert.ok(result.coverage.reasons.includes("remote_candidate_projection_rejected"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("all out-of-range candidates remain visibly incomplete", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<file path="/codebase/src/ledger/repair.ts"><range>25-26</range></file>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.projection.rejected_candidates, 1);
    assert.deepEqual(result.projection.rejection_reasons, ["remote_candidate_range_rejected"]);
    assert.ok(result.coverage.reasons.includes("remote_candidate_projection_rejected"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an invalid remote range is recovered from an exact prior local read", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? restrictedExecFrame({
            command1: {
              type: "readfile",
              file: "/codebase/src/ledger/repair.ts",
              start_line: 1,
              end_line: 80,
            },
          })
          : answerFrame(
            '<file path="/codebase/src/ledger/repair.ts"><range>1-25</range></file>',
          );
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates, [{
      path: "src/ledger/repair.ts",
      start_line: 1,
      end_line: 24,
      reason: "local_range_validated",
    }]);
    assert.deepEqual(result.projection, {
      remote_candidates: 1,
      accepted_candidates: 1,
      recovered_candidates: 0,
      rejected_candidates: 0,
      unprocessed_candidates: 0,
      rejection_reasons: [],
    });
    assert.deepEqual(result.coverage.reasons, ["remote_candidate_range_recovered"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a test-only answer is supplemented by locally verified implementation evidence", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? restrictedExecFrame({
            command1: {
              type: "readfile",
              file: "/codebase/src/ledger/repair.ts",
              start_line: 1,
              end_line: 80,
            },
            command2: {
              type: "readfile",
              file: "/codebase/test/ledger-repair.test.ts",
              start_line: 1,
              end_line: 80,
            },
          })
          : answerFrame(
            '<file path="/codebase/test/ledger-repair.test.ts"><range>1-11</range></file>',
          );
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      "src/ledger/repair.ts",
      "test/ledger-repair.test.ts",
    ]);
    assert.deepEqual(result.projection, {
      remote_candidates: 1,
      accepted_candidates: 2,
      recovered_candidates: 1,
      rejected_candidates: 0,
      unprocessed_candidates: 0,
      rejection_reasons: [],
    });
    assert.deepEqual(result.coverage.reasons, ["implementation_candidate_recovered"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a test-only answer recovers one locally imported implementation", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? restrictedExecFrame({
            command1: {
              type: "readfile",
              file: "/codebase/test/ledger-repair.test.ts",
              start_line: 1,
              end_line: 80,
            },
          })
          : answerFrame(
            '<file path="/codebase/test/ledger-repair.test.ts"><range>1-11</range></file>',
          );
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      "src/ledger/repair.ts",
      "test/ledger-repair.test.ts",
    ]);
    assert.equal(result.projection.recovered_candidates, 1);
    assert.deepEqual(result.coverage.reasons, ["implementation_candidate_recovered"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

async function implementationAnswerWithRg(root, executorOptions) {
  let streamCalls = 0;
  const result = await search({
    query: "resume interrupted financial records",
    guard: new PathGuard(root),
    apiKey: syntheticKey,
    executorOptions,
    fetchImpl: async (url) => {
      if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
        return response(protoString("eyJ.synthetic.jwt"));
      }
      streamCalls += 1;
      const frame = streamCalls === 1
        ? restrictedExecFrame({
          command1: {
            type: "readfile",
            file: "/codebase/src/ledger/repair.ts",
            start_line: 1,
            end_line: 80,
          },
          command2: {
            type: "rg",
            pattern: "export",
            path: "/codebase/src",
          },
        })
        : answerFrame(
          '<file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>',
        );
      return response(connectResponse([frame]), {
        headers: { "Connect-Content-Encoding": "gzip" },
      });
    },
  });
  return { result, streamCalls };
}

test("a valid implementation answer does not expose unrelated rg exploration hits", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const runProcess = async (_binary, args) => {
      const separator = args.indexOf("--");
      const unrelatedPath = args
        .slice(separator + 1)
        .find((value) => value.replaceAll("\\", "/").endsWith("/src/catalog/pricing.ts"));
      assert.notEqual(separator, -1);
      assert.ok(unrelatedPath);
      return {
        status: 0,
        stdout: `${JSON.stringify({
          type: "match",
          data: {
            path: { text: unrelatedPath },
            lines: { text: "export const pricing = true;\n" },
            line_number: 1,
          },
        })}\n`,
      };
    };
    const { result, streamCalls } = await implementationAnswerWithRg(root, {
      rgBinary: join(tmpdir(), "deterministic-test-rg"),
      runProcess,
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      "src/ledger/repair.ts",
    ]);
    assert.equal(result.projection.recovered_candidates, 0);
    assert.deepEqual(result.coverage.reasons, []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an unavailable rg command remains a visible local tool failure", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const { result, streamCalls } = await implementationAnswerWithRg(root, {
      rgBinary: "rg",
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      "src/ledger/repair.ts",
    ]);
    assert.equal(result.projection.recovered_candidates, 0);
    assert.deepEqual(result.coverage.reasons, ["local_tool_failure"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a locally read implementation is retained when the remote answer selects another source file", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  writeFileSync(join(root, "src", "ledger", "helper.ts"), "export const helper = true;\n");
  let streamCalls = 0;
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        const frame = streamCalls === 1
          ? restrictedExecFrame({
            command1: {
              type: "readfile",
              file: "/codebase/src/ledger/repair.ts",
              start_line: 1,
              end_line: 80,
            },
            command2: {
              type: "readfile",
              file: "/codebase/src/ledger/helper.ts",
              start_line: 1,
              end_line: 20,
            },
          })
          : answerFrame(
            '<file path="/codebase/src/ledger/helper.ts"><range>1-1</range></file>',
          );
        return response(connectResponse([frame]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        });
      },
    });
    assert.equal(streamCalls, 2);
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
      "src/ledger/repair.ts",
      "src/ledger/helper.ts",
    ]);
    assert.deepEqual(result.coverage.reasons, ["implementation_candidate_recovered"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("partial candidate projection retains only local successes and counts rejections", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>'
          + '<file path="/codebase/test/ledger-repair.test.ts"><range>12-13</range></file>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates, [{
      path: "src/ledger/repair.ts",
      start_line: 1,
      end_line: 24,
      reason: "local_range_validated",
    }]);
    assert.deepEqual(result.projection, {
      remote_candidates: 2,
      accepted_candidates: 1,
      recovered_candidates: 0,
      rejected_candidates: 1,
      unprocessed_candidates: 0,
      rejection_reasons: ["remote_candidate_range_rejected"],
    });
    assert.ok(result.coverage.reasons.includes("remote_candidate_projection_rejected"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the candidate result limit leaves later remote candidates visibly unprocessed", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      maxResults: 1,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame(
          '<file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>'
          + '<file path="/codebase/test/ledger-repair.test.ts"><range>1-11</range></file>',
        )]), { headers: { "Connect-Content-Encoding": "gzip" } }),
    });
    assert.equal(result.status, "truncated");
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/ledger/repair.ts"]);
    assert.deepEqual(result.projection, {
      remote_candidates: 2,
      accepted_candidates: 1,
      recovered_candidates: 0,
      rejected_candidates: 0,
      unprocessed_candidates: 1,
      rejection_reasons: [],
    });
    assert.deepEqual(result.coverage.reasons, ["candidate_result_limit"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("one unstructured answer receives one bounded answer-only shape correction", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  const protocolEvents = [];
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      onProtocolEvent(event) { protocolEvents.push(event); },
      fetchImpl: async (url) => {
        if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
          return response(protoString("eyJ.synthetic.jwt"));
        }
        streamCalls += 1;
        return response(connectResponse([
          streamCalls === 1
            ? answerFrame("the implementation is in the ledger module")
            : answerFrame('<file path="/codebase/src/ledger/repair.ts"><range>1-24</range></file>'),
        ]), { headers: { "Connect-Content-Encoding": "gzip" } });
      },
    });
    assert.equal(streamCalls, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["src/ledger/repair.ts"]);
    assert.ok(protocolEvents.some((event) => event.event === "answer_correction"
      && event.tool_name === "answer"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("unstructured answer text is a protocol error after one bounded correction", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    await assert.rejects(
      search({
        query: "resume interrupted financial records",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => {
          if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
            return response(protoString("eyJ.synthetic.jwt"));
          }
          streamCalls += 1;
          return response(connectResponse([answerFrame("no result found")]), {
            headers: { "Connect-Content-Encoding": "gzip" },
          });
        },
      }),
      (error) => error?.code === "FC_PROTOCOL_INVALID"
        && error?.protocolReason === "answer_missing_explicit_no_results",
    );
    assert.equal(streamCalls, 2);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an empty shape correction cannot erase a prior nonempty malformed answer", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  let streamCalls = 0;
  try {
    await assert.rejects(
      search({
        query: "resume interrupted financial records",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => {
          if (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit")) {
            return response(protoString("eyJ.synthetic.jwt"));
          }
          streamCalls += 1;
          const answer = streamCalls === 1
            ? "candidate path: test/ledger-repair.test.ts"
            : "<ANSWER></ANSWER>";
          return response(connectResponse([answerFrame(answer)]), {
            headers: { "Connect-Content-Encoding": "gzip" },
          });
        },
      }),
      (error) => error?.code === "FC_PROTOCOL_INVALID"
        && error?.protocolReason === "answer_missing_explicit_no_results",
    );
    assert.equal(streamCalls, 2);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("only an explicit no-results answer may be complete with zero candidates", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame("<no_results/>")]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.projection, {
      remote_candidates: 0,
      accepted_candidates: 0,
      recovered_candidates: 0,
      rejected_candidates: 0,
      unprocessed_candidates: 0,
      rejection_reasons: [],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the established empty ANSWER XML remains an explicit no-results answer", async () => {
  const { root, temporaryRoot } = ledgerFixture();
  try {
    const result = await search({
      query: "resume interrupted financial records",
      guard: new PathGuard(root),
      apiKey: syntheticKey,
      fetchImpl: async (url) => (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
        ? response(protoString("eyJ.synthetic.jwt"))
        : response(connectResponse([answerFrame("<ANSWER></ANSWER>")]), {
          headers: { "Connect-Content-Encoding": "gzip" },
        }),
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.projection, {
      remote_candidates: 0,
      accepted_candidates: 0,
      recovered_candidates: 0,
      rejected_candidates: 0,
      unprocessed_candidates: 0,
      rejection_reasons: [],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
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
        if ((url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))) return response(protoString("eyJ.synthetic.jwt"));
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
        return (url.includes("GetUserJwt") || url.includes("CheckUserMessageRateLimit"))
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(connectResponse([restrictedExecFrame(fourTreeCommands())]), {
            headers: { "Connect-Content-Encoding": "gzip" },
          });
      },
    }),
    { code: "FC_REMOTE_UNAVAILABLE" },
  );
  assert.equal(fetchCalls, 3);
  assert.equal(toolCalls, 2);
  assert.ok(performance.now() - started < 500);
});
