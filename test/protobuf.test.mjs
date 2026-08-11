import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  connectFrameDecode,
  connectFrameEncode,
} from "../scripts/lib/protobuf.mjs";

function envelope(payload, flags, declaredLength = payload.length) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(declaredLength, 1);
  return Buffer.concat([header, payload]);
}

function endStream(value = {}, compress = false) {
  const json = Buffer.from(JSON.stringify(value));
  return envelope(compress ? gzipSync(json) : json, compress ? 0x03 : 0x02);
}

test("Connect decoder accepts exact single, multi, identity, and gzip streams", () => {
  const first = Buffer.from("first");
  const second = Buffer.from("second");

  assert.deepEqual(
    connectFrameDecode(Buffer.concat([connectFrameEncode(first, false), endStream()])),
    [first],
  );
  assert.deepEqual(
    connectFrameDecode(Buffer.concat([
      connectFrameEncode(first, true),
      connectFrameEncode(second, false),
      endStream({}, true),
    ]), { encoding: "gzip" }),
    [first, second],
  );
});
test("Connect decoder rejects malformed headers, lengths, tails, and reserved flags", () => {
  const validMessage = connectFrameEncode(Buffer.from("message"), false);
  const validEnd = endStream();
  const cases = [
    Buffer.from([0, 0, 0, 0]),
    envelope(Buffer.from("short"), 0, 100),
    Buffer.concat([envelope(Buffer.from("long"), 0, 1), validEnd]),
    Buffer.concat([validMessage, validEnd, Buffer.from([1, 2, 3])]),
    Buffer.concat([envelope(Buffer.from("message"), 0x04), validEnd]),
    Buffer.concat([envelope(Buffer.from("message"), 0x80), validEnd]),
  ];
  for (const value of cases) {
    assert.throws(() => connectFrameDecode(value), { code: "FC_PROTOCOL_INVALID" });
  }
});

test("Connect decoder enforces compression negotiation and never falls back to raw bytes", () => {
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      envelope(Buffer.from("not-gzip"), 0x01),
      endStream(),
    ]), { encoding: "gzip" }),
    { code: "FC_PROTOCOL_INVALID" },
  );
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.from("compressed"), true),
      endStream(),
    ])),
    { code: "FC_PROTOCOL_INVALID" },
  );
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.from("compressed"), true),
      endStream(),
    ]), { encoding: "br" }),
    { code: "FC_PROTOCOL_INVALID" },
  );
});

test("Connect decoder requires one final successful EndStreamResponse", () => {
  const message = connectFrameEncode(Buffer.from("message"), false);
  const cases = [
    message,
    Buffer.concat([endStream(), message]),
    Buffer.concat([message, endStream(), endStream()]),
    Buffer.concat([message, envelope(Buffer.from("not-json"), 0x02)]),
    Buffer.concat([message, endStream({ error: null })]),
    Buffer.concat([message, endStream({ metadata: [] })]),
  ];
  for (const value of cases) {
    assert.throws(() => connectFrameDecode(value), { code: "FC_PROTOCOL_INVALID" });
  }
});

test("Connect protocol diagnostics retain fixed reasons without serializing payload data", () => {
  let incomplete;
  let remoteError;
  let numericRemoteError;
  try {
    connectFrameDecode(Buffer.from([0, 0, 0, 0]));
  } catch (error) {
    incomplete = error;
  }
  try {
    connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.from("message"), false),
      endStream({ error: { code: "unavailable", message: "REMOTE_BODY_SENTINEL" } }),
    ]));
  } catch (error) {
    remoteError = error;
  }
  try {
    connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.from("message"), false),
      endStream({ error: { code: 3, message: "REMOTE_BODY_SENTINEL" } }),
    ]));
  } catch (error) {
    numericRemoteError = error;
  }
  assert.equal(incomplete?.code, "FC_PROTOCOL_INVALID");
  assert.equal(incomplete?.protocolReason, "connect_frame_header_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(incomplete)), {
    name: "FastContextError",
    code: "FC_PROTOCOL_INVALID",
  });
  assert.equal(remoteError?.protocolReason, "connect_end_stream_unavailable");
  assert.equal(numericRemoteError?.protocolReason, "connect_end_stream_invalid_argument");
  assert.deepEqual(JSON.parse(JSON.stringify(remoteError)), {
    name: "FastContextError",
    code: "FC_REMOTE_UNAVAILABLE",
  });
  assert.equal(numericRemoteError?.code, "FC_PROTOCOL_INVALID");
});

test("Connect EndStream remote errors map stable service categories without error text", () => {
  const cases = [
    ["unauthenticated", "FC_AUTH_REJECTED"],
    ["permission_denied", "FC_AUTH_REJECTED"],
    ["deadline_exceeded", "FC_REMOTE_TIMEOUT"],
    ["resource_exhausted", "FC_REMOTE_UNAVAILABLE"],
    ["internal", "FC_REMOTE_SERVER_ERROR"],
  ];
  for (const [remoteCode, publicCode] of cases) {
    let error;
    try {
      connectFrameDecode(Buffer.concat([
        connectFrameEncode(Buffer.from("message"), false),
        endStream({ error: { code: remoteCode, message: "REMOTE_BODY_SENTINEL" } }),
      ]));
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, publicCode);
    assert.equal(error?.protocolReason, `connect_end_stream_${remoteCode}`);
    assert.doesNotMatch(JSON.stringify(error), /REMOTE_BODY_SENTINEL/);
  }
});

test("Connect decoder separately bounds compressed, decompressed, and cumulative frame bytes", () => {
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.from("12345"), false),
      endStream(),
    ]), { maxFrameCompressedBytes: 4 }),
    { code: "FC_OUTPUT_LIMIT" },
  );
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.alloc(32, 65), true),
      endStream(),
    ]), { encoding: "gzip", maxFrameDecompressedBytes: 16 }),
    { code: "FC_OUTPUT_LIMIT" },
  );
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.alloc(10), false),
      connectFrameEncode(Buffer.alloc(10), false),
      endStream(),
    ]), { maxResponseDecompressedBytes: 16 }),
    { code: "FC_OUTPUT_LIMIT" },
  );
  assert.throws(
    () => connectFrameDecode(Buffer.concat([
      connectFrameEncode(Buffer.from("message"), false),
      endStream(),
    ]), { maxFrameCompressedBytes: 0 }),
    { code: "FC_PROTOCOL_INVALID" },
  );
});
