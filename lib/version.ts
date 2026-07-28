import pkg from "../package.json";

// Single source of truth for the version PassControl advertises publicly.
// Three surfaces — the JSON-LD `softwareVersion`, the FAQ's honest-status answer,
// and the footer — each carried a hand-typed version, and by 0.4.0 they had drifted
// to 0.2.0 / v0.2.x / v0.1.x respectively. Import these instead of typing a number.
export const RELEASE_VERSION: string = pkg.version;

/** The "early (v0.4.x)" form used in prose — a patch release doesn't move it. */
export const RELEASE_SERIES = `v${RELEASE_VERSION.split(".").slice(0, 2).join(".")}.x`;
