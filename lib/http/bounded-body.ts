/**
 * Read a request body with a real byte bound.
 *
 * ── What was wrong with `await req.text()` and a length check ──────────────
 *
 * Two things, and they fail in opposite directions.
 *
 * **It bounded nothing.** `Content-Length` is a hint a client chooses to send;
 * a chunked upload has none. Without it, `req.text()` consumes the ENTIRE stream
 * before any check runs, so the limit was enforced after the allocation it exists
 * to prevent. Measured: sixteen 1 MiB chunks were fully consumed against a 4 MiB
 * cap before the 413. An unterminated upload keeps going until the platform kills
 * it, and on a self-hosted single-process gateway that pressure is shared with
 * every other tenant on the box.
 *
 * **And it bounded the wrong unit.** `String.prototype.length` counts UTF-16 code
 * units, not bytes. Every character outside the BMP costs two code units; every
 * ordinary CJK character costs one code unit but THREE bytes. So a JSON body of
 * 1.5 million CJK characters measures ~1.5M by `.length` and ~4.5 MB on the wire
 * — comfortably past a cap that reported it as comfortably inside one.
 *
 * ── What this does instead ────────────────────────────────────────────────
 *
 * Counts bytes as they arrive and CANCELS the stream the moment the cap is
 * crossed, so the sender is refused rather than drained. Decoding happens once,
 * at the end, over bytes that are already known to be within the bound.
 *
 * `Content-Length`, when present, is still checked first — but as an
 * optimisation that avoids opening a stream we would only close, never as the
 * enforcement. The enforcement is the counter below.
 */
export type BoundedBody = { ok: true; text: string } | { ok: false; reason: "too_large" };

export async function readBoundedBody(req: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };

  const body = req.body;
  // No stream at all is an empty body, not an error: GETs arrive here too.
  if (!body) return { ok: true, text: await req.text() };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling. Everything after this point is never read, which is the
        // whole difference between a bound and a report.
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  // One decode, over bytes already known to be inside the bound. `fatal` is
  // deliberately off: a truncated multi-byte sequence becomes U+FFFD and the
  // JSON parse downstream rejects it with the ordinary invalid-body error,
  // rather than throwing out of the reader as an unhandled failure.
  return { ok: true, text: new TextDecoder("utf-8").decode(joined) };
}
