// Serving one avatar.
//
// This route is unauthenticated and it is deliberately OUTSIDE /api/: 
// next.config.mjs applies `no-store` to `/api/:path*`, which would defeat the
// caching that the whole capability-token design exists to enable. It is also
// excluded from the middleware matcher, for the reason .well-known already is —
// a PUBLIC_PATHS entry would still run supabase.auth.getUser(), a network round
// trip on a document meant to be fetched and cached.
//
// ── Why there is no authorization check here ────────────────────────────────
//
// The key IS the authorization. It is 128 bits of randomness minted by
// newAvatarKey(), it is not derivable from the handle or the tenant id, and
// avatar_object_path() in 0033 is keyed on it and on nothing else. Three
// consequences worth stating, because each one looks like an oversight:
//
//   * The route does not check `profile_public`. That is what lets the
//     operator's own sidebar chip render while their profile is private, using
//     the same URL. Revocation is by ROTATING the key — setProfilePublic(false)
//     does exactly that — not by a flag read here.
//   * The tenant uuid never appears in the URL. 0015 requires that the tenant is
//     never named on a public surface, and a uuid in an <img src> would also be
//     a correlation handle into dashboard URLs.
//   * The response is immutable-cacheable, because a given key can only ever
//     name one set of bytes. A new upload mints a new key.
//
// The RPC returns ONE column — the storage path — so this route physically
// cannot select `email` or `plan` even if a later edit is careless.
import { NextResponse } from "next/server";

import { AVATAR_CONTENT_TYPES, sniffAvatar, type AvatarContentType } from "@/lib/profile/image";
import { serviceClient } from "@/lib/supabase";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const BUCKET = "avatars";

/** A year. Safe because the key changes whenever the bytes do. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Shape-checked before it reaches the database, so a junk path costs nothing. */
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

function notFound(): NextResponse {
  // 404 for a missing key, a missing object and a malformed key alike. A
  // distinguishable response would turn this into an oracle for which keys
  // exist, and the key is the entire access control.
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
  const { key } = await context.params;
  if (!KEY_RE.test(key ?? "")) return notFound();

  const admin = serviceClient();
  const { data, error } = await admin.rpc("avatar_object_path", { p_key: key });
  if (error) return notFound();

  const row = Array.isArray(data) ? data[0] : data;
  const objectPath =
    row && typeof row === "object" && typeof (row as { object_path?: unknown }).object_path === "string"
      ? (row as { object_path: string }).object_path
      : null;
  if (!objectPath) return notFound();

  const download = await admin.storage.from(BUCKET).download(objectPath);
  if (download.error || !download.data) return notFound();

  const bytes = new Uint8Array(await download.data.arrayBuffer());

  // The content type is RE-DERIVED from the bytes on the way out, never read
  // from stored metadata, the object name, or anything the uploader supplied.
  // Storage is a place bytes are kept, not a source of truth about what they
  // are — and this route serves same-origin content on the domain that holds
  // the session cookie, so the type it declares is the thing that matters.
  const sniffed = sniffAvatar(bytes);
  if (!sniffed.ok) return notFound();
  const contentType: AvatarContentType = AVATAR_CONTENT_TYPES.includes(sniffed.contentType)
    ? sniffed.contentType
    : "image/png";

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": CACHE_CONTROL,
      // Belt and braces with the allowlisted type above: even if a future edit
      // let something else through, the browser must not sniff its way to
      // treating it as a document on our own origin.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // These bytes are an image and nothing else. If the type check ever fails
      // open, this is what stops the result being an executable document.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
