import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PathGuard } from "../scripts/lib/path-guard.mjs";
import { search } from "../scripts/lib/core.mjs";
import { ProtobufEncoder, connectFrameEncode } from "../scripts/lib/protobuf.mjs";

const syntheticKey = "synthetic-key-not-a-real-credential";

function response(body, ok = true) {
  return { ok, async arrayBuffer() { return Buffer.from(body); } };
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

test("search uses injected protocol responses and locally revalidates candidates", async () => {
  const root = fixture();
  const calls = [];
  try {
    const guard = new PathGuard(root);
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.includes("GetUserJwt")) return response(protoString("eyJ.synthetic.jwt"));
      return response(connectFrameEncode(protoString(
        "[TOOL_CALLS]answer[ARGS]{\"answer\":\"<file path=\\\"/codebase/src/candidate.mjs\\\"><range>1-2</range></file><file path=\\\"/tmp/SECRET_SENTINEL\\\"><range>1-2</range></file>\"}",
      )));
    };
    const result = await search({ query: "find candidate", guard, apiKey: syntheticKey, fetchImpl });
    assert.deepEqual(result.candidates, [{
      path: "src/candidate.mjs",
      start_line: 1,
      end_line: 2,
      reason: "semantic_candidate",
    }]);
    assert.deepEqual(result.search_terms, ["find", "candidate"]);
    assert.equal(calls.length, 2);
    assert.match(calls[0].options.body.toString("utf8"), /synthetic-key/);
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

test("oversized remote body is rejected without exposing its contents", async () => {
  const root = fixture();
  try {
    const oversized = Buffer.alloc(512 * 1024 + 1, 65);
    await assert.rejects(
      search({
        query: "query",
        guard: new PathGuard(root),
        apiKey: syntheticKey,
        fetchImpl: async (url) => url.includes("GetUserJwt")
          ? response(protoString("eyJ.synthetic.jwt"))
          : response(oversized),
      }),
      { code: "FC_OUTPUT_LIMIT" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
