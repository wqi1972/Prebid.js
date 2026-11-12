/**
 * Encoder for log-prebid-events-newsiq.proto, used instead of protobufjs
 * (which, with its bytebuffer and long dependencies, added about 27 KB gzipped
 * to every bundle that includes the adapter).
 *
 * For values protobufjs v5 accepts, the output is byte-identical to
 * `new LogPrebidEventsNewsIQ(payload).toArrayBuffer()`: fields are written in
 * the order they are declared in the schema (not by field number), and null or
 * undefined fields are omitted. Where protobufjs throws (and the whole batch
 * was lost), this encoder skips the bad field instead: a non-string for a
 * string field, a non-integer for uint32, a non-number for double or fixed64,
 * a non-object for a message, and keys the schema does not have.
 */

// [field number, name, type, sub-schema], in schema declaration order.
const CREATIVE = [
  [1, "creative_id", "string"],
  [2, "width", "uint32"],
  [3, "height", "uint32"],
  [4, "brand", "string"],
];

const BID = [
  [1, "bid_id", "string"],
  [2, "price", "double"],
  [3, "bidder_code", "string"],
  [4, "bidder_ad_unit_id", "string"],
  [5, "request_timestamp", "fixed64"],
  [6, "response_timestamp", "fixed64"],
  [7, "status_code", "uint32"],
  [9, "source", "string"],
  [8, "creative", "message", CREATIVE],
];

const PARAM = [
  [1, "key", "string"],
  [2, "value", "string"],
];

const AD_UNIT = [
  [1, "ad_unit_code", "string"],
  [2, "bids", "message", BID],
  [3, "params", "message", PARAM],
];

export const AUCTION = [
  [1, "version", "string"],
  [2, "auction_init_timestamp", "fixed64"],
  [3, "prebid_auction_id", "string"],
  [4, "configured_timeout_ms", "uint32"],
  [5, "ad_units", "message", AD_UNIT],
  [6, "msg_type", "uint32"],
];

export const PAYLOAD = [
  [1, "timestamp", "fixed64"],
  [2, "remote_addr_macro", "string"],
  [3, "user_agent_macro", "string"],
  [4, "referer_url", "string"],
  [5, "seller_member_id", "uint32"],
  [6, "domain", "string"],
  [7, "device", "string"],
  [8, "auctions", "message", AUCTION],
  [9, "platform", "string"],
];

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LDELIM = 2;
const TWO_32 = 4294967296;
const TWO_64 = TWO_32 * TWO_32;

const f64 = new DataView(new ArrayBuffer(8));

function writeVarint(out, value) {
  value >>>= 0;
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
}

function writeUint32LE(out, value) {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Unsigned 64-bit from a JS number, as Long.fromNumber(value, true) does. */
function writeFixed64(out, value) {
  let low = 0;
  let high = 0;
  if (!isFinite(value)) {
    // NaN and Infinity encode as 0.
  } else if (value >= TWO_64) {
    low = high = 0xffffffff;
  } else if (value > 0) {
    low = value % TWO_32 >>> 0;
    high = (value / TWO_32) >>> 0;
  }
  writeUint32LE(out, low);
  writeUint32LE(out, high);
}

function writeDouble(out, value) {
  if (Number.isNaN(value)) {
    // protobufjs (bytebuffer's ieee754 writer) encodes NaN as 0x7ff0000000000001.
    out.push(1, 0, 0, 0, 0, 0, 0xf0, 0x7f);
    return;
  }
  f64.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) out.push(f64.getUint8(i));
}

/** UTF-8 bytes; a lone surrogate becomes U+FFFD, as with TextEncoder. */
function utf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

function isString(value) {
  return typeof value === "string" || value instanceof String;
}

function append(out, bytes) {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

/** Appends one field value, or nothing if the value does not fit the type. */
function writeField(out, id, type, sub, value) {
  switch (type) {
    case "string": {
      if (!isString(value)) return;
      const bytes = utf8("" + value);
      writeVarint(out, (id << 3) | WIRE_LDELIM);
      writeVarint(out, bytes.length);
      append(out, bytes);
      return;
    }
    case "uint32":
      // protobufjs lets NaN through and writes it as 0.
      if (typeof value !== "number" || (!Number.isNaN(value) && value % 1 !== 0)) return;
      writeVarint(out, (id << 3) | WIRE_VARINT);
      writeVarint(out, value);
      return;
    case "double":
      if (typeof value !== "number") return;
      writeVarint(out, (id << 3) | WIRE_FIXED64);
      writeDouble(out, value);
      return;
    case "fixed64":
      if (typeof value !== "number") return;
      writeVarint(out, (id << 3) | WIRE_FIXED64);
      writeFixed64(out, value);
      return;
    case "message": {
      if (!value || typeof value !== "object") return;
      const body = encodeMessage(sub, value);
      writeVarint(out, (id << 3) | WIRE_LDELIM);
      writeVarint(out, body.length);
      append(out, body);
    }
  }
}

/** Encodes `obj` with `schema`; returns the bytes as a plain array. */
export function encodeMessage(schema, obj) {
  const out = [];
  for (let i = 0; i < schema.length; i++) {
    const [id, name, type, sub] = schema[i];
    const value = obj[name];
    if (value === null || value === undefined) continue;
    if (sub) {
      // Repeated fields (all message fields here except creative) accept a
      // single value too, as protobufjs does.
      const values = Array.isArray(value) ? value : [value];
      values.forEach((v) => {
        if (v !== null && v !== undefined) writeField(out, id, type, sub, v);
      });
    } else {
      writeField(out, id, type, sub, value);
    }
  }
  return out;
}

/** The full beacon body for a LogPrebidEventsNewsIQ payload. */
export function encodePayload(payload) {
  return new Uint8Array(encodeMessage(PAYLOAD, payload));
}

/** Encoded size in bytes of one Auction message. */
export function auctionBytes(auction) {
  return encodeMessage(AUCTION, auction).length;
}
