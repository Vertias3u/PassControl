const GRID_SIZE = 7 as const;
const HALF_GRID_WIDTH = 4;
const PUBLIC_KEY_BYTES = 32;
const PUBLIC_KEY_BASE64URL_LENGTH = 43;

type SigilPalette = Readonly<{
  background: string;
  foreground: string;
  accent: string;
}>;

/*
 * These are deliberately fixed literals. A passport ID selects a palette; it
 * never becomes part of a CSS or SVG color value.
 */
const PALETTES: readonly SigilPalette[] = [
  {
    background: "#E8E2D2",
    foreground: "#17383B",
    accent: "#A7583B",
  },
  {
    background: "#E3E8DF",
    foreground: "#203A32",
    accent: "#9B6B32",
  },
  {
    background: "#E3E8EC",
    foreground: "#1F3447",
    accent: "#9A5549",
  },
  {
    background: "#E8E4DE",
    foreground: "#302F3D",
    accent: "#8A6039",
  },
] as const;

const NEUTRAL_PALETTE: SigilPalette = {
  background: "#E5E7EB",
  foreground: "#4B5563",
  accent: "#9CA3AF",
};

export type PassportSigilCell = Readonly<{
  x: number;
  y: number;
}>;

export type PassportSigil = Readonly<{
  gridSize: typeof GRID_SIZE;
  cells: readonly PassportSigilCell[];
  background: string;
  foreground: string;
  accent: string;
  isFallback: boolean;
}>;

const NEUTRAL_CELLS: readonly PassportSigilCell[] = [
  { x: 2, y: 0 },
  { x: 3, y: 0 },
  { x: 4, y: 0 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 4, y: 1 },
  { x: 5, y: 1 },
  { x: 0, y: 2 },
  { x: 1, y: 2 },
  { x: 5, y: 2 },
  { x: 6, y: 2 },
  { x: 0, y: 3 },
  { x: 2, y: 3 },
  { x: 3, y: 3 },
  { x: 4, y: 3 },
  { x: 6, y: 3 },
  { x: 0, y: 4 },
  { x: 1, y: 4 },
  { x: 5, y: 4 },
  { x: 6, y: 4 },
  { x: 1, y: 5 },
  { x: 2, y: 5 },
  { x: 4, y: 5 },
  { x: 5, y: 5 },
  { x: 2, y: 6 },
  { x: 3, y: 6 },
  { x: 4, y: 6 },
] as const;

function neutralSigil(): PassportSigil {
  return {
    gridSize: GRID_SIZE,
    cells: NEUTRAL_CELLS.map(({ x, y }) => ({ x, y })),
    ...NEUTRAL_PALETTE,
    isFallback: true,
  };
}

function base64urlValue(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 45) return 62;
  if (code === 95) return 63;
  return -1;
}

/**
 * Decode only the canonical, unpadded base64url shape of a raw Ed25519 public
 * key. The length check happens before scanning so malformed legacy or
 * attacker-controlled input cannot make sigil generation do unbounded work.
 */
function decodePublicKey(passportId: string): Uint8Array | null {
  if (
    typeof passportId !== "string" ||
    passportId.length !== PUBLIC_KEY_BASE64URL_LENGTH
  ) {
    return null;
  }

  const bytes = new Uint8Array(PUBLIC_KEY_BYTES);
  let buffer = 0;
  let bits = 0;
  let byteIndex = 0;

  for (let index = 0; index < PUBLIC_KEY_BASE64URL_LENGTH; index += 1) {
    const value = base64urlValue(passportId.charCodeAt(index));
    if (value < 0) return null;

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      if (byteIndex >= PUBLIC_KEY_BYTES) return null;
      bytes[byteIndex] = (buffer >>> bits) & 0xff;
      byteIndex += 1;
      buffer &= (1 << bits) - 1;
    }
  }

  // 43 base64url characters encode 32 bytes plus two zero padding bits.
  if (byteIndex !== PUBLIC_KEY_BYTES || bits !== 2 || buffer !== 0) return null;
  return bytes;
}

function seedFromPublicKey(bytes: Uint8Array): number {
  let seed = 0x811c9dc5;

  for (let index = 0; index < PUBLIC_KEY_BYTES; index += 1) {
    seed ^= bytes[index] ?? 0;
    seed = Math.imul(seed, 0x01000193);
  }

  // xorshift32 cannot advance from zero.
  return seed === 0 ? 0x9e3779b9 : seed >>> 0;
}

function nextRandom(state: number): number {
  let next = state;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function cellsFromSeed(initialSeed: number): readonly PassportSigilCell[] {
  const halfRows: boolean[][] = [];
  let state = initialSeed;

  for (let y = 0; y < GRID_SIZE; y += 1) {
    const row = new Array<boolean>(HALF_GRID_WIDTH).fill(false);
    let occupied = 0;

    for (let x = 0; x < HALF_GRID_WIDTH; x += 1) {
      state = nextRandom(state);
      if ((state & 1) === 1) {
        row[x] = true;
        occupied += 1;
      }
    }

    // Keep even degenerate byte patterns visually substantial. This loop is
    // capped at four iterations because the half-row has exactly four cells.
    const start = state & 3;
    for (let offset = 0; offset < HALF_GRID_WIDTH && occupied < 2; offset += 1) {
      const x = (start + offset) & 3;
      if (!row[x]) {
        row[x] = true;
        occupied += 1;
      }
    }

    halfRows.push(row);
  }

  const cells: PassportSigilCell[] = [];
  for (let y = 0; y < GRID_SIZE; y += 1) {
    const row = halfRows[y] ?? [];
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const sourceX = x <= 3 ? x : GRID_SIZE - 1 - x;
      if (row[sourceX]) cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Build a deterministic, horizontally mirrored 7×7 sigil from a passport's
 * raw 32-byte Ed25519 public key. Invalid and legacy identifiers share one
 * bounded neutral fallback.
 */
export function createPassportSigil(passportId: string): PassportSigil {
  const publicKey = decodePublicKey(passportId);
  if (!publicKey) return neutralSigil();

  const seed = seedFromPublicKey(publicKey);
  const palette = PALETTES[seed % PALETTES.length] ?? PALETTES[0]!;

  return {
    gridSize: GRID_SIZE,
    cells: cellsFromSeed(seed),
    ...palette,
    isFallback: false,
  };
}

/**
 * Passport IDs are public keys, but exports remain redacted unless the user
 * explicitly opts in to revealing the full identifier.
 */
export function passportIdForDisplay(
  passportId: string,
  revealFull = false
): string {
  if (typeof passportId !== "string") return "";
  return revealFull ? passportId : `${passportId.slice(0, 8)}…`;
}
