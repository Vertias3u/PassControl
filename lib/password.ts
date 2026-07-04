// Server-side password strength validation for signup / password change.
// Supabase Auth stores the hash (bcrypt); it does NOT enforce a strength policy,
// so we gate weak passwords here before calling auth.signUp. Pure + testable.

const MIN_LENGTH = 12;
const MAX_LENGTH = 200; // bcrypt truncates at 72 bytes, but reject absurd input early.

// Small embedded list of the most-abused passwords / patterns. Not exhaustive —
// the length + composition checks below carry most of the weight. We compare
// case-insensitively and also block these as substrings of short passwords.
const COMMON = new Set([
  "password",
  "passw0rd",
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty",
  "qwertyuiop",
  "letmein",
  "iloveyou",
  "admin",
  "welcome",
  "monkey",
  "dragon",
  "abc123",
  "111111",
  "000000",
  "changeme",
  "passport",
  "passcontrol",
  "secret",
  "default",
]);

/** Returns an error message if the password is too weak, or null if acceptable. */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  if (password.length > MAX_LENGTH) {
    return "Password is too long.";
  }

  const lower = password.toLowerCase();
  if (COMMON.has(lower)) {
    return "That password is too common. Please choose something less guessable.";
  }
  // Reject a known-weak word as the dominant component of a short password.
  for (const word of COMMON) {
    if (lower.includes(word) && password.length < MIN_LENGTH + word.length) {
      return "That password is too common. Please choose something less guessable.";
    }
  }

  // Require at least three of four character classes to avoid trivial strings
  // like "aaaaaaaaaaaa" passing the length gate alone.
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  if (classes < 3) {
    return "Password must mix upper- and lower-case letters, numbers, or symbols.";
  }

  return null;
}
