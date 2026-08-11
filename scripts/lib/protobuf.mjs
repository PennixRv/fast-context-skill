/**
 * Hand-written Protobuf encoder/decoder + Connect-RPC frame handling.
 *
 * Matches the Windsurf wire format exactly.
 * Python bytearray → Node.js Buffer
 * struct.pack(">I", len) → buf.writeUInt32BE
 * gzip.compress/decompress → zlib.gzipSync/gunzipSync
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { FastContextError } from "./public-error.mjs";

export const CONNECT_LIMITS = Object.freeze({
  MAX_RESPONSE_COMPRESSED_BYTES: 512 * 1024,
  MAX_FRAME_COMPRESSED_BYTES: 256 * 1024,
  MAX_FRAME_DECOMPRESSED_BYTES: 512 * 1024,
  MAX_RESPONSE_DECOMPRESSED_BYTES: 1024 * 1024,
});

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const CONNECT_ERROR_CODES = new Set([
  "canceled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal",
  "unavailable",
  "data_loss",
  "unauthenticated",
]);
const CONNECT_ERROR_CODES_BY_NUMBER = new Map([
  [1, "canceled"],
  [2, "unknown"],
  [3, "invalid_argument"],
  [4, "deadline_exceeded"],
  [5, "not_found"],
  [6, "already_exists"],
  [7, "permission_denied"],
  [8, "resource_exhausted"],
  [9, "failed_precondition"],
  [10, "aborted"],
  [11, "out_of_range"],
  [12, "unimplemented"],
  [13, "internal"],
  [14, "unavailable"],
  [15, "data_loss"],
  [16, "unauthenticated"],
]);
const CONNECT_ERROR_PUBLIC_CODES = new Map([
  ["unauthenticated", "FC_AUTH_REJECTED"],
  ["permission_denied", "FC_AUTH_REJECTED"],
  ["deadline_exceeded", "FC_REMOTE_TIMEOUT"],
  ["resource_exhausted", "FC_REMOTE_UNAVAILABLE"],
  ["unavailable", "FC_REMOTE_UNAVAILABLE"],
  ["canceled", "FC_REMOTE_UNAVAILABLE"],
  ["aborted", "FC_REMOTE_UNAVAILABLE"],
  ["internal", "FC_REMOTE_SERVER_ERROR"],
  ["unknown", "FC_REMOTE_SERVER_ERROR"],
  ["data_loss", "FC_REMOTE_SERVER_ERROR"],
]);

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

function remoteEndStreamErrorReason(error) {
  const code = typeof error?.code === "string"
    ? error.code.trim().toLowerCase()
    : CONNECT_ERROR_CODES_BY_NUMBER.get(error?.code);
  return CONNECT_ERROR_CODES.has(code)
    ? `connect_end_stream_${code}`
    : "connect_end_stream_remote_error";
}

function remoteEndStreamError(error) {
  const reason = remoteEndStreamErrorReason(error);
  const code = reason.slice("connect_end_stream_".length);
  const publicCode = CONNECT_ERROR_PUBLIC_CODES.get(code) || "FC_PROTOCOL_INVALID";
  const publicError = new FastContextError(publicCode);
  Object.defineProperty(publicError, "protocolReason", {
    value: reason,
    enumerable: false,
  });
  return publicError;
}

function outputLimitError() {
  return new FastContextError("FC_OUTPUT_LIMIT");
}

function positiveLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw protocolError("connect_limit_invalid");
  return value;
}

// ─── Protobuf Encoder ──────────────────────────────────────

export class ProtobufEncoder {
  constructor() {
    /** @type {Buffer[]} */
    this._chunks = [];
  }

  /**
   * Encode an unsigned varint into a Buffer.
   * @param {number} value
   * @returns {Buffer}
   */
  _varint(value) {
    const bytes = [];
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
  }

  /**
   * Encode a field tag.
   * @param {number} field
   * @param {number} wire
   * @returns {Buffer}
   */
  _tag(field, wire) {
    return this._varint((field << 3) | wire);
  }

  /**
   * Write a varint field.
   * @param {number} field
   * @param {number} value
   * @returns {ProtobufEncoder}
   */
  writeVarint(field, value) {
    this._chunks.push(this._tag(field, 0), this._varint(value));
    return this;
  }

  /**
   * Write a length-delimited string field.
   * @param {number} field
   * @param {string} value
   * @returns {ProtobufEncoder}
   */
  writeString(field, value) {
    const data = Buffer.from(value, "utf-8");
    this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
    return this;
  }

  /**
   * Write a length-delimited bytes field.
   * @param {number} field
   * @param {Buffer|Uint8Array} value
   * @returns {ProtobufEncoder}
   */
  writeBytes(field, value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._chunks.push(this._tag(field, 2), this._varint(buf.length), buf);
    return this;
  }

  /**
   * Write a nested message field.
   * @param {number} field
   * @param {ProtobufEncoder} sub
   * @returns {ProtobufEncoder}
   */
  writeMessage(field, sub) {
    const data = sub.toBuffer();
    this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
    return this;
  }

  /**
   * Return the encoded bytes as a Buffer.
   * @returns {Buffer}
   */
  toBuffer() {
    return Buffer.concat(this._chunks);
  }
}

// ─── Varint Decode ─────────────────────────────────────────

/**
 * Decode a varint from a buffer at the given offset.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {[number, number]} [value, newOffset]
 */
export function decodeVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [value, offset];
}

// ─── Protobuf String Extraction ────────────────────────────

/**
 * Extract all UTF-8 strings (length > 5) from raw protobuf data
 * by parsing wire types. Matches Python proto_extract_strings().
 * @param {Buffer} data
 * @returns {string[]}
 */
export function extractStrings(data) {
  const strings = [];
  let i = 0;
  while (i < data.length) {
    // Read tag varint
    let tag = 0;
    let shift = 0;
    while (i < data.length) {
      const b = data[i++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const wire = tag & 0x7;
    if (wire === 0) {
      // Varint — skip
      while (i < data.length) {
        const b = data[i++];
        if (!(b & 0x80)) break;
      }
    } else if (wire === 1) {
      // 64-bit fixed
      i += 8;
    } else if (wire === 2) {
      // Length-delimited
      let length = 0;
      shift = 0;
      while (i < data.length) {
        const b = data[i++];
        length |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (i + length <= data.length) {
        const raw = data.subarray(i, i + length);
        try {
          const text = raw.toString("utf-8");
          if (text.length > 5) {
            strings.push(text);
          }
        } catch {
          // Not valid UTF-8, skip
        }
      }
      i += length;
    } else if (wire === 5) {
      // 32-bit fixed
      i += 4;
    } else {
      // Unknown wire type — stop
      break;
    }
  }
  return strings;
}

// ─── Connect-RPC Frame Encode/Decode ───────────────────────

/**
 * Encode protobuf bytes into a gzip-compressed Connect-RPC frame.
 * Frame format: 1-byte flags + 4-byte big-endian length + payload
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @returns {Buffer}
 */
export function connectFrameEncode(protoBytes, compress = true) {
  let payload;
  let flags;
  if (compress) {
    payload = gzipSync(protoBytes);
    flags = 1; // gzip compressed
  } else {
    payload = protoBytes;
    flags = 0;
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Decode a complete Connect streaming response.
 * @param {Buffer|Uint8Array} data
 * @param {{
 *   encoding?: "identity"|"gzip"|string,
 *   maxFrameCompressedBytes?: number,
 *   maxFrameDecompressedBytes?: number,
 *   maxResponseDecompressedBytes?: number,
 * }} [options]
 * @returns {Buffer[]}
 */
export function connectFrameDecode(data, options = {}) {
  if (!(data instanceof Uint8Array)) throw protocolError("connect_data_invalid");
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const encoding = String(options.encoding || "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") throw protocolError("connect_encoding_invalid");

  const maxFrameCompressedBytes = positiveLimit(
    options.maxFrameCompressedBytes ?? CONNECT_LIMITS.MAX_FRAME_COMPRESSED_BYTES,
  );
  const maxFrameDecompressedBytes = positiveLimit(
    options.maxFrameDecompressedBytes ?? CONNECT_LIMITS.MAX_FRAME_DECOMPRESSED_BYTES,
  );
  const maxResponseDecompressedBytes = positiveLimit(
    options.maxResponseDecompressedBytes ?? CONNECT_LIMITS.MAX_RESPONSE_DECOMPRESSED_BYTES,
  );

  const frames = [];
  let offset = 0;
  let totalDecompressedBytes = 0;
  let sawEndStream = false;

  while (offset < buffer.length) {
    if (buffer.length - offset < 5) throw protocolError("connect_frame_header_incomplete");
    const flags = buffer[offset];
    if ((flags & ~0x03) !== 0) throw protocolError("connect_frame_flags_invalid");

    const length = buffer.readUInt32BE(offset + 1);
    if (length > maxFrameCompressedBytes) throw outputLimitError();
    const payloadStart = offset + 5;
    const payloadEnd = payloadStart + length;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > buffer.length) {
      throw protocolError("connect_frame_length_invalid");
    }

    const compressed = (flags & 0x01) !== 0;
    const endStream = (flags & 0x02) !== 0;
    let payload = buffer.subarray(payloadStart, payloadEnd);
    if (compressed) {
      if (encoding !== "gzip") throw protocolError("connect_compression_not_negotiated");
      try {
        payload = gunzipSync(payload, { maxOutputLength: maxFrameDecompressedBytes });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE") throw outputLimitError();
        throw protocolError("connect_gzip_invalid");
      }
    } else if (payload.length > maxFrameDecompressedBytes) {
      throw outputLimitError();
    }

    if (totalDecompressedBytes > maxResponseDecompressedBytes - payload.length) {
      throw outputLimitError();
    }
    totalDecompressedBytes += payload.length;
    offset = payloadEnd;

    if (endStream) {
      if (sawEndStream || offset !== buffer.length) throw protocolError("connect_end_stream_not_final");
      let end;
      try {
        end = JSON.parse(utf8Decoder.decode(payload));
      } catch {
        throw protocolError("connect_end_stream_payload_invalid");
      }
      if (!end || typeof end !== "object" || Array.isArray(end)) {
        throw protocolError("connect_end_stream_payload_invalid");
      }
      if (Object.hasOwn(end, "error")) {
        throw remoteEndStreamError(end.error);
      }
      if (
        Object.hasOwn(end, "metadata")
        && (!end.metadata || typeof end.metadata !== "object" || Array.isArray(end.metadata))
      ) {
        throw protocolError("connect_end_stream_metadata_invalid");
      }
      sawEndStream = true;
      continue;
    }

    frames.push(payload);
  }

  if (!sawEndStream) throw protocolError("connect_end_stream_missing");
  return frames;
}
