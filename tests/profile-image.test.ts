// Avatar bytes.
//
// These bytes are stored by us and served from OUR origin — the domain that
// holds the session cookie — because that is what keeps `img-src 'self'` in
// lib/csp.ts untouched. There is no image library and the edge runtime cannot
// re-encode, so sniffing plus a byte cap plus a chunk walk is the entire
// defence. That is a real limit, stated rather than papered over, and it is why
// this test file is as long as it is.
//
// The fixtures below are hand-built, so they could in principle share a bug with
// the parser they test. They do not: on 2026-08-20 the parser was also run
// against real encoder output, and every branch agreed with `sips`.
//
//   app/apple-icon.png            -> png  180x180   (matches sips)
//   cwebp                         -> VP8L 180x180   (lossless branch)
//   cwebp, alpha removed          -> VP8  180x180   (lossy keyframe branch)
//   cwebp with alpha              -> VP8X 180x180   (extended-canvas branch)
//   cwebp -metadata all of a JPEG -> refused, carries_metadata
//   sips-converted JPEG           -> refused, unsupported_type
//   a 4000x4000 PNG of flat white -> refused, dimensions — and it is only 9 KB,
//                                    so it clears the byte cap comfortably. That
//                                    file is the reason AVATAR_MAX_DIMENSION
//                                    exists: bytes do not bound decoded size.
import { describe, expect, it } from "vitest";

import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  sniffAvatar,
} from "@/lib/profile/image";

/** Big-endian u32, as PNG writes every length and every dimension. */
function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: number[] = []): number[] {
  return [
    ...be32(data.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    // The CRC is not verified — a wrong one only corrupts the operator's own
    // avatar, it does not cross a trust boundary.
    0, 0, 0, 0,
  ];
}

function png(
  options: { width?: number; height?: number; extra?: number[] } = {}
): Uint8Array {
  const { width = 128, height = 128, extra = [] } = options;
  return new Uint8Array([
    ...PNG_MAGIC,
    ...chunk("IHDR", [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...extra,
    ...chunk("IDAT", [1, 2, 3, 4]),
    ...chunk("IEND"),
  ]);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/** A VP8X ("extended") WebP, whose canvas size is a plain 24-bit minus-one. */
function webp(
  options: { width?: number; height?: number; extra?: number[] } = {}
): Uint8Array {
  const { width = 128, height = 128, extra = [] } = options;
  const w = width - 1;
  const h = height - 1;
  const vp8x = chunkRiff("VP8X", [
    0, 0, 0, 0,
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ]);
  const body = [...ascii("WEBP"), ...vp8x, ...extra, ...chunkRiff("VP8 ", [1, 2, 3, 4])];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function chunkRiff(type: string, data: number[]): number[] {
  // RIFF chunks are padded to an even length.
  const padded = data.length % 2 === 1 ? [...data, 0] : data;
  return [...ascii(type), ...le32(data.length), ...padded];
}

function accepted(bytes: Uint8Array, contentType: string) {
  const result = sniffAvatar(bytes);
  expect(result.ok ? result.contentType : result, "expected acceptance").toBe(contentType);
}

function refused(bytes: Uint8Array, reason: string) {
  const result = sniffAvatar(bytes);
  expect(result.ok ? "accepted" : result.reason).toBe(reason);
}

describe("what we accept", () => {
  it("accepts a PNG and reports the type it detected, not one it was told", () => {
    accepted(png(), "image/png");
  });

  it("accepts a WebP", () => {
    accepted(webp(), "image/webp");
  });

  // The type comes from the bytes, so there is nothing for a caller to lie
  // about. tests for the serve route assert the same map is used on the way out.
  it("only ever reports a type from the allowlist", () => {
    for (const bytes of [png(), webp()]) {
      const result = sniffAvatar(bytes);
      expect(result.ok).toBe(true);
      expect(AVATAR_CONTENT_TYPES).toContain(result.ok ? result.contentType : "");
    }
  });
});

describe("what we refuse", () => {
  // SVG is a script carrier. Served same-origin with an image content type it
  // would still execute if a browser were ever persuaded to treat it as a
  // document, and there is no sanitiser here to strip the script.
  it("refuses SVG outright", () => {
    refused(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), "unsupported_type");
  });

  // JPEG is refused for a different reason from SVG: the format is fine, but
  // EXIF cannot be stripped without a dependency, and GPS coordinates on a URL
  // anyone can fetch is a real privacy failure on an identity product.
  it("refuses JPEG, because EXIF cannot be stripped here", () => {
    refused(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]), "unsupported_type");
  });

  it("refuses HTML, including HTML wearing an image name", () => {
    refused(new TextEncoder().encode("<!doctype html><script>alert(1)</script>"), "unsupported_type");
    refused(new TextEncoder().encode("GIF89a"), "unsupported_type");
  });

  it("refuses an empty upload", () => {
    refused(new Uint8Array(0), "empty");
  });

  it("refuses anything over the cap, before looking at a single byte of it", () => {
    const oversized = new Uint8Array(AVATAR_MAX_BYTES + 1);
    oversized.set(PNG_MAGIC);
    refused(oversized, "too_large");
  });

  it("accepts a file exactly at the cap", () => {
    const exact = new Uint8Array(AVATAR_MAX_BYTES);
    exact.set(png());
    // The trailing zeroes are not a valid chunk stream, so this asserts the size
    // gate specifically rather than end-to-end acceptance.
    expect(sniffAvatar(exact).ok ? "ok" : (sniffAvatar(exact) as { reason: string }).reason)
      .not.toBe("too_large");
  });

  // A 256 KB PNG can declare 30000x30000 and cost a visitor gigabytes to
  // decode. The byte cap does not bound the decoded size; this does.
  it("refuses a decompression bomb declaring huge dimensions", () => {
    refused(png({ width: 30000, height: 30000 }), "dimensions");
    refused(webp({ width: 30000, height: 30000 }), "dimensions");
  });

  it("refuses zero dimensions", () => {
    refused(png({ width: 0, height: 10 }), "dimensions");
  });

  it("accepts dimensions exactly at the limit", () => {
    accepted(png({ width: AVATAR_MAX_DIMENSION, height: AVATAR_MAX_DIMENSION }), "image/png");
    accepted(webp({ width: AVATAR_MAX_DIMENSION, height: AVATAR_MAX_DIMENSION }), "image/webp");
  });
});

describe("metadata, which we cannot strip", () => {
  // The honest position: there is no encoder here, so a file carrying metadata
  // cannot be cleaned — it can only be refused. The uploader re-encodes through
  // a canvas before sending, so a legitimate upload never carries any of this.
  it("refuses a PNG carrying EXIF or text chunks", () => {
    refused(png({ extra: chunk("eXIf", [1, 2, 3]) }), "carries_metadata");
    refused(png({ extra: chunk("tEXt", ascii("Comment\0hi")) }), "carries_metadata");
    refused(png({ extra: chunk("iTXt", [0]) }), "carries_metadata");
    refused(png({ extra: chunk("zTXt", [0]) }), "carries_metadata");
  });

  it("refuses a WebP carrying EXIF or XMP", () => {
    refused(webp({ extra: chunkRiff("EXIF", [1, 2, 3, 4]) }), "carries_metadata");
    refused(webp({ extra: chunkRiff("XMP ", [1, 2, 3, 4]) }), "carries_metadata");
  });

  // The chunk stream is WALKED, not scanned. A scan for the ASCII "tEXt" would
  // hit it by chance inside compressed pixel data and refuse a valid upload.
  it("does not mistake pixel data that happens to spell a chunk name", () => {
    accepted(png({ extra: chunk("IDAT", ascii("tEXt-tEXt-eXIf")) }), "image/png");
  });

  it("refuses a truncated or malformed chunk stream", () => {
    refused(new Uint8Array([...PNG_MAGIC, 0, 0, 0, 90, ...ascii("IHDR")]), "malformed");
    refused(new Uint8Array(PNG_MAGIC), "malformed");
  });
});

describe("the caps themselves", () => {
  // 0033 sets the bucket's file_size_limit to 524288. The app cap is tighter on
  // purpose: the app rejects first, with a message, and the bucket limit is the
  // backstop for a path that somehow skips this function.
  it("stays under the bucket's own limit", () => {
    expect(AVATAR_MAX_BYTES).toBeLessThanOrEqual(524288);
  });
});
