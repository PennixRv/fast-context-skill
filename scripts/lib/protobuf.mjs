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

function protocolError() {
  return new FastContextError("FC_PROTOCOL_INVALID");
}

function outputLimitError() {
  return new FastContextError("FC_OUTPUT_LIMIT");
}

function positiveLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw protocolError();
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
  if (!(data instanceof Uint8Array)) throw protocolError();
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const encoding = String(options.encoding || "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") throw protocolError();

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
    if (buffer.length - offset < 5) throw protocolError();
    const flags = buffer[offset];
    if ((flags & ~0x03) !== 0) throw protocolError();

    const length = buffer.readUInt32BE(offset + 1);
    if (length > maxFrameCompressedBytes) throw outputLimitError();
    const payloadStart = offset + 5;
    const payloadEnd = payloadStart + length;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > buffer.length) throw protocolError();

    const compressed = (flags & 0x01) !== 0;
    const endStream = (flags & 0x02) !== 0;
    let payload = buffer.subarray(payloadStart, payloadEnd);
    if (compressed) {
      if (encoding !== "gzip") throw protocolError();
      try {
        payload = gunzipSync(payload, { maxOutputLength: maxFrameDecompressedBytes });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE") throw outputLimitError();
        throw protocolError();
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
      if (sawEndStream || offset !== buffer.length) throw protocolError();
      let end;
      try {
        end = JSON.parse(utf8Decoder.decode(payload));
      } catch {
        throw protocolError();
      }
      if (!end || typeof end !== "object" || Array.isArray(end)) throw protocolError();
      if (Object.hasOwn(end, "error")) throw protocolError();
      if (
        Object.hasOwn(end, "metadata")
        && (!end.metadata || typeof end.metadata !== "object" || Array.isArray(end.metadata))
      ) {
        throw protocolError();
      }
      sawEndStream = true;
      continue;
    }

    frames.push(payload);
  }

  if (!sawEndStream) throw protocolError();
  return frames;
}
