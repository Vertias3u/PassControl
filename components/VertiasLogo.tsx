// Vertias company mark — the exact three-petal flare from the supplied brand
// asset. Solid fills are intentional: this component appears more than once in
// responsive shells, so fixed SVG gradient ids would collide across instances
// and can leave the visible mark referencing paint inside a hidden SVG.
export function VertiasLogo({ size = 44 }: { size?: number }) {
  const height = Math.round((size * 62) / 58);
  return (
    <svg width={size} height={height} viewBox="0 0 58 62" fill="none" role="img" aria-label="Vertias">
      <path
        d="M29 57C25 47 12 36 10 20 8 9 14 3 19 6c6 4 7 20 9 33 1 8 1 13 1 18Z"
        fill="#7fa933"
      />
      <path
        d="M29 57c-2-12-5-29-3-43 1-8 4-13 7-12 4 1 5 8 3 19-2 13-5 26-7 36Z"
        fill="#b7f34a"
      />
      <path
        d="M29 57c4-10 14-21 19-37 3-10-2-17-7-14-6 4-8 20-10 33-1 8-2 13-2 18Z"
        fill="#94c63b"
      />
    </svg>
  );
}

// Wordmark: "Vertias" with the brand-green second half.
export function VertiasWordmark({ size = 20 }: { size?: number }) {
  return (
    <span style={{ fontWeight: 800, fontSize: size, letterSpacing: "-0.02em" }}>
      Ver<span style={{ color: "#b7f34a" }}>tias</span>
    </span>
  );
}
