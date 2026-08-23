"use client";
// The avatar, re-encoded in the browser before it is ever sent.
//
// This is not a convenience. lib/profile/image.ts refuses any file carrying
// EXIF, XMP or a PNG text chunk, because there is no image library on the edge
// runtime and metadata cannot be stripped server-side — so a photo straight off
// a phone, with GPS coordinates in it, WOULD be refused. Drawing it onto a
// canvas and reading the bytes back produces a file with none of that: the
// canvas holds pixels, and nothing else survives the round trip.
//
// So the pipeline is: pick → draw to a square canvas at most AVATAR_EDGE across
// → re-encode → upload. That simultaneously strips metadata, bounds the
// dimensions, and usually brings a multi-megabyte photo under the 256 KB cap.
// The server does not trust any of it — sniffAvatar() re-derives the type from
// the bytes and the caps are enforced again there. This makes the common case
// work; it is not the control.
import { useRef, useState, useTransition } from "react";
import { ImageUp, Trash2, UserRound } from "lucide-react";

import {
  removeAvatar,
  uploadAvatar,
  type ProfileActionState,
} from "@/app/dashboard/settings/profile-actions";

/** Output edge in pixels. Comfortably inside AVATAR_MAX_DIMENSION, and more than
 *  enough for a chip rendered at 32px on a 2x display. */
const AVATAR_EDGE = 512;

/** Matches AVATAR_MAX_BYTES. Re-stated rather than imported so this client
 *  bundle does not pull in the byte parser. */
const MAX_BYTES = 256 * 1024;

/** What we ask the canvas for, in order. WebP is materially smaller at the same
 *  quality; a browser that cannot produce it silently hands back a PNG, which is
 *  why the result is sniffed rather than assumed. */
const ENCODINGS: { type: string; quality: number }[] = [
  { type: "image/webp", quality: 0.9 },
  { type: "image/png", quality: 1 },
];

function initials(displayName: string | null, handle: string | null): string {
  const source = (displayName ?? handle ?? "").trim();
  if (!source) return "";
  const words = source.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/** Draw the picture square, cropped to its centre, at most AVATAR_EDGE across. */
async function reencode(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  const side = Math.min(bitmap.width, bitmap.height);
  const edge = Math.min(AVATAR_EDGE, side);
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    edge,
    edge
  );
  bitmap.close();

  for (const encoding of ENCODINGS) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, encoding.type, encoding.quality)
    );
    // A browser asked for a format it cannot encode returns PNG instead, so the
    // type is read off the blob rather than assumed from what we requested.
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  return null;
}

export function AvatarUploader({
  avatarKey,
  hasAvatar,
  displayName,
  handle,
  onResult,
}: {
  avatarKey: string | null;
  hasAvatar: boolean;
  displayName: string | null;
  handle: string | null;
  onResult: (state: ProfileActionState) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The key is the cache-buster: a new upload mints a new one, so this URL is
  // safe to cache immutably and an old one simply stops resolving.
  const src = preview ?? (hasAvatar && avatarKey ? `/avatars/${avatarKey}` : null);

  const choose = (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    start(async () => {
      const encoded = await reencode(file);
      if (!encoded) {
        setProblem(
          "That image could not be prepared. Use a PNG or WebP under 256 KB, or crop it smaller."
        );
        return;
      }
      // Shown immediately so the operator sees the crop that will be stored,
      // not the file they picked.
      setPreview(URL.createObjectURL(encoded));

      const body = new FormData();
      body.set("avatar", new File([encoded], "avatar", { type: encoded.type }));
      const result = await uploadAvatar(body);
      // A rejected upload must not leave a preview standing — it would show the
      // operator a picture that is not stored anywhere.
      if (result.error) setPreview(null);
      onResult(result);
    });
  };

  return (
    <div className="pc-profile-avatar">
      <div className="pc-profile-avatar__frame" data-state={src ? "set" : "empty"}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- served from our
          // own origin by app/avatars/[key], deliberately not through the image
          // optimizer: these bytes are already bounded and re-encoded.
          <img src={src} alt="" width={96} height={96} />
        ) : (
          <span aria-hidden="true">{initials(displayName, handle) || <UserRound />}</span>
        )}
      </div>

      <div className="pc-profile-avatar__body">
        <strong>Avatar</strong>
        <p>
          PNG or WebP, up to 256 KB. It is cropped square and re-encoded in your browser before
          it is sent, which removes any location or camera data the original carried — we cannot
          strip that on our side, so a file that still has it is refused.
        </p>
        {problem && (
          <p className="pc-field-note is-warning" role="alert">
            {problem}
          </p>
        )}
        <div className="pc-profile-avatar__actions">
          <input
            ref={input}
            type="file"
            accept="image/png,image/webp,image/jpeg"
            hidden
            onChange={(event) => {
              choose(event.target.files?.[0]);
              // Reset so choosing the same file twice fires again.
              event.target.value = "";
            }}
          />
          <button type="button" disabled={pending} onClick={() => input.current?.click()}>
            <ImageUp aria-hidden="true" /> {hasAvatar ? "Replace" : "Upload"}
          </button>
          {hasAvatar && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setPreview(null);
                  onResult(await removeAvatar());
                })
              }
            >
              <Trash2 aria-hidden="true" /> Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
