// Vertias company mark — three petals of a leaf (the flare). Brand orange,
// preserved from the Vertias identity. One instance per page (static gradient ids).
export function VertiasLogo({ size = 44 }: { size?: number }) {
  const height = Math.round((size * 62) / 58);
  return (
    <svg width={size} height={height} viewBox="0 0 58 62" fill="none" role="img" aria-label="Vertias">
      <defs>
        <linearGradient id="vertias-a" x1="20" y1="58" x2="12" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0e7490" />
          <stop offset="100%" stopColor="#67e8f9" />
        </linearGradient>
        <linearGradient id="vertias-b" x1="29" y1="58" x2="29" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00e5ff" />
          <stop offset="100%" stopColor="#cffafe" />
        </linearGradient>
        <linearGradient id="vertias-c" x1="38" y1="58" x2="46" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0e7490" />
          <stop offset="100%" stopColor="#67e8f9" />
        </linearGradient>
      </defs>
      <path
        d="M 29 56 C 26 48 14 36 11 20 C 9 10 15 4 19 6 C 24 8 26 22 27 34 C 28 42 29 50 29 56 Z"
        fill="url(#vertias-a)"
        opacity="0.92"
      />
      <path
        d="M 29 56 C 28 46 25 30 26 16 C 27 7 30 2 32 2 C 35 2 37 8 36 18 C 35 30 31 46 29 56 Z"
        fill="url(#vertias-b)"
      />
      <path
        d="M 29 56 C 32 48 40 36 45 20 C 48 10 43 4 39 6 C 34 8 32 22 31 34 C 30 42 29 50 29 56 Z"
        fill="url(#vertias-c)"
        opacity="0.88"
      />
      <ellipse cx="29" cy="55" rx="5" ry="3" fill="#00e5ff" opacity="0.3" />
    </svg>
  );
}

// Wordmark: "Vertias" with the brand-orange second half.
export function VertiasWordmark({ size = 20 }: { size?: number }) {
  return (
    <span style={{ fontWeight: 800, fontSize: size, letterSpacing: "-0.02em" }}>
      Ver<span style={{ color: "#00e5ff" }}>tias</span>
    </span>
  );
}
