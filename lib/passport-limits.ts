// Bounds on passport rotation, in a module with NO imports.
//
// It lives here rather than in lib/fleet.ts because the rotation UI is a client
// component and needs the same number the server enforces. Importing it from
// fleet would drag @upstash/redis, the Supabase service client and the whole
// killswitch module into the browser bundle — server-only code, shipped to the
// browser, to read one integer.
//
// The alternative — retyping the number in the component — is the failure
// validateFallbacks documents at length: a form offering a choice the server
// refuses, discovered by an operator at the moment they try to use it.
export const MAX_ROTATION_GRACE_S = 7 * 24 * 60 * 60;
