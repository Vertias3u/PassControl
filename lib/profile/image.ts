// Avatar validation, without an image library.
//
// The trade-off this design accepts, stated plainly. Serving avatar bytes from
// our own origin is what keeps `img-src 'self' data: blob:` in lib/csp.ts
// untouched — a public Supabase bucket URL would force a third-party origin
// into the policy on every page. The cost is that these bytes live on the
// domain that holds the session cookie. There is no image library here and the
// edge runtime cannot re-encode, so the defence is: a byte cap, a magic-byte
// sniff, a walk of the container's chunk structure, and a decoded-dimension
// bound. Nothing else. This file does not pretend to sanitise anything.
//
// Two formats only:
//
//   PNG, WebP  — accepted.
//   JPEG       — REFUSED, though the format is perfectly fine. EXIF cannot be
//                stripped without a dependency, and GPS coordinates attached to
//                a URL anyone can fetch is a privacy failure on a product whose
//                whole subject is identity. 0033's bucket allowed_mime_types
//                names the same two formats.
//   SVG        — REFUSED. It is a script carrier and there is no sanitiser here.
//
// The metadata rule follows from the same limit: a file carrying EXIF, XMP or a
// PNG text chunk cannot be cleaned, so it is refused instead. That is not a
// hardship in practice — components/AvatarUploader.tsx re-encodes through a
// canvas before upload, which produces a file with none of it.

/**
 * 256 KB. Tighter than the bucket's own `file_size_limit` (524288 in 0033) on
 * purpose: this rejects first, with a message an operator can act on, and the
 * bucket limit stays as a backstop for any path that skips this function.
 */
export const AVATAR_MAX_BYTES = 256 * 1024;

/**
 * The byte cap does not bound the DECODED size — a 256 KB PNG can legally
 * declare 30000x30000 and cost a visitor gigabytes of memory to render. This
 * does. An avatar is displayed at a few dozen pixels.
 */
export const AVATAR_MAX_DIMENSION = 2048;

export const AVATAR_CONTENT_TYPES = ["image/png", "image/webp"] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

export type AvatarRejection =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "dimensions"
  | "carries_metadata"
  | "malformed";

export type AvatarSniffResult =
  | { ok: true; contentType: AvatarContentType; width: number; height: number }
  | { ok: false; reason: AvatarRejection };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG ancillary chunks that carry text or EXIF. Refused; see the header. */
const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);

/** The RIFF chunks that carry metadata in a WebP container. */
const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP "]);

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24 >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    ((bytes[offset + 3] ?? 0) << 24 >>> 0)
  );
}

function le24(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16)
  );
}

function boundsOk(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= AVATAR_MAX_DIMENSION &&
    height <= AVATAR_MAX_DIMENSION
  );
}

/**
 * Walk the PNG chunk stream.
 *
 * WALKED rather than scanned, and the difference matters: searching the buffer
 * for the ASCII "tEXt" would hit it by chance inside compressed IDAT data
 * roughly once in every few tens of thousands of uploads, and refuse a
 * perfectly good avatar with a message about metadata it does not contain.
 */
function sniffPng(bytes: Uint8Array): AvatarSniffResult {
  // Signature + the IHDR chunk (4 length + 4 type + 13 data + 4 crc).
  if (bytes.length < 8 + 25) return { ok: false, reason: "malformed" };
  if (ascii(bytes, 12, 4) !== "IHDR") return { ok: false, reason: "malformed" };

  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  if (!boundsOk(width, height)) return { ok: false, reason: "dimensions" };

  let offset = 8;
  let sawEnd = false;
  while (offset + 8 <= bytes.length) {
    const length = be32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    // Length is unsigned 32-bit; an absurd one is a truncated or hostile file
    // rather than a chunk we should try to skip over.
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, reason: "malformed" };
    const next = offset + 12 + length;
    if (next > bytes.length) return { ok: false, reason: "malformed" };
    if (PNG_METADATA_CHUNKS.has(type)) return { ok: false, reason: "carries_metadata" };
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = next;
  }
  if (!sawEnd) return { ok: false, reason: "malformed" };

  return { ok: true, contentType: "image/png", width, height };
}

/**
 * Walk the RIFF chunk stream of a WebP.
 *
 * Three body formats exist and each stores its size differently, so all three
 * are read rather than guessed at: VP8X carries an explicit canvas size, VP8 is
 * a lossy keyframe, VP8L is the lossless bitstream. A file whose body chunk is
 * none of those is refused rather than admitted with unknown dimensions.
 */
function sniffWebp(bytes: Uint8Array): AvatarSniffResult {
  if (bytes.length < 20) return { ok: false, reason: "malformed" };
  const declared = le32(bytes, 4);
  // The RIFF length counts everything after the length field itself.
  if (declared + 8 > bytes.length) return { ok: false, reason: "malformed" };

  let width = 0;
  let height = 0;
  let offset = 12;
  const end = Math.min(bytes.length, declared + 8);

  while (offset + 8 <= end) {
    const type = ascii(bytes, offset, 4);
    const length = le32(bytes, offset + 4);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, reason: "malformed" };
    const dataAt = offset + 8;
    if (dataAt + length > end) return { ok: false, reason: "malformed" };

    if (WEBP_METADATA_CHUNKS.has(type)) return { ok: false, reason: "carries_metadata" };

    if (!width) {
      if (type === "VP8X" && length >= 10) {
        width = le24(bytes, dataAt + 4) + 1;
        height = le24(bytes, dataAt + 7) + 1;
      } else if (type === "VP8 " && length >= 10) {
        // 3-byte frame tag, then the 3-byte sync code 9d 01 2a, then two
        // 16-bit little-endian fields whose top 2 bits are a scale factor.
        if (bytes[dataAt + 3] !== 0x9d || bytes[dataAt + 4] !== 0x01 || bytes[dataAt + 5] !== 0x2a) {
          return { ok: false, reason: "malformed" };
        }
        width = ((bytes[dataAt + 6] ?? 0) | ((bytes[dataAt + 7] ?? 0) << 8)) & 0x3fff;
        height = ((bytes[dataAt + 8] ?? 0) | ((bytes[dataAt + 9] ?? 0) << 8)) & 0x3fff;
      } else if (type === "VP8L" && length >= 5) {
        if (bytes[dataAt] !== 0x2f) return { ok: false, reason: "malformed" };
        const bits =
          (bytes[dataAt + 1] ?? 0) |
          ((bytes[dataAt + 2] ?? 0) << 8) |
          ((bytes[dataAt + 3] ?? 0) << 16) |
          ((bytes[dataAt + 4] ?? 0) << 24);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
    }

    // RIFF pads every chunk to an even length.
    offset = dataAt + length + (length % 2);
  }

  if (!width) return { ok: false, reason: "malformed" };
  if (!boundsOk(width, height)) return { ok: false, reason: "dimensions" };
  return { ok: true, contentType: "image/webp", width, height };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Remove metadata instead of refusing the file that carries it.
 *
 * The refusal above rested on a premise that is only half true. "Metadata
 * cannot be stripped without an image library" holds for JPEG, whose EXIF sits
 * in a segment structure entangled with the entropy-coded scan — which is why
 * JPEG is still refused. It does NOT hold for PNG or WebP. Both are chunked
 * containers: every chunk carries its own length and its own CRC, so dropping
 * one is a byte-slice and everything remaining stays valid. No re-encode, no
 * dependency, no pixel touched.
 *
 * The cost of not knowing that was an operator being told to strip a PNG they
 * had already stripped by hand — advice they could not act on, about a file
 * this function can simply clean.
 *
 * Anything it cannot parse is returned unchanged; sniffAvatar is what refuses.
 * It never mutates the input.
 */
export function stripAvatarMetadata(bytes: Uint8Array): Uint8Array {
  if (startsWith(bytes, PNG_MAGIC)) return stripPng(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return stripWebp(bytes);
  return bytes;
}

function stripPng(bytes: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let removed = false;
  while (offset + 8 <= bytes.length) {
    const length = be32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (!Number.isSafeInteger(length) || length < 0) return bytes;
    const next = offset + 12 + length;
    if (next > bytes.length) return bytes;
    if (PNG_METADATA_CHUNKS.has(type)) removed = true;
    else kept.push(bytes.subarray(offset, next));
    if (type === "IEND") break;
    offset = next;
  }
  return removed ? concat(kept) : bytes;
}

/** VP8X advertises what the container holds; those bits must follow the chunks. */
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 20) return bytes;
  const declared = le32(bytes, 4);
  if (declared + 8 > bytes.length) return bytes;
  const end = Math.min(bytes.length, declared + 8);

  const kept: Uint8Array[] = [];
  let offset = 12;
  let removed = false;
  while (offset + 8 <= end) {
    const type = ascii(bytes, offset, 4);
    const length = le32(bytes, offset + 4);
    if (!Number.isSafeInteger(length) || length < 0) return bytes;
    const dataAt = offset + 8;
    if (dataAt + length > end) return bytes;
    const padded = length + (length % 2);
    if (WEBP_METADATA_CHUNKS.has(type)) {
      removed = true;
    } else if (type === "VP8X" && length >= 1) {
      // Copied, never mutated in place: subarray shares the caller's buffer.
      const chunk = bytes.slice(offset, dataAt + padded);
      chunk[8] = (chunk[8] ?? 0) & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      kept.push(chunk);
    } else {
      kept.push(bytes.subarray(offset, dataAt + padded));
    }
    offset = dataAt + padded;
  }
  if (!removed) return bytes;

  // "WEBP" plus every surviving chunk. The RIFF length counts everything after
  // the length field itself — stale, it sends decoders past the end.
  const bodyLength = 4 + kept.reduce((sum, part) => sum + part.length, 0);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  header.set([bodyLength & 0xff, (bodyLength >>> 8) & 0xff, (bodyLength >>> 16) & 0xff, (bodyLength >>> 24) & 0xff], 4);
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([header, ...kept]);
}

/**
 * Decide what these bytes are, from the bytes.
 *
 * The uploader's declared MIME type and the filename are never consulted — both
 * are claims made by whoever is uploading. The returned `contentType` is the
 * one the serve route sets, and it can only ever be a member of
 * AVATAR_CONTENT_TYPES.
 *
 * Order is deliberate: size before content, so an oversized upload costs a
 * length check rather than a parse.
 */
export function sniffAvatar(bytes: Uint8Array): AvatarSniffResult {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: "too_large" };

  if (startsWith(bytes, PNG_MAGIC)) return sniffPng(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return sniffWebp(bytes);

  return { ok: false, reason: "unsupported_type" };
}
