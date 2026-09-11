// Driven by tests/passport-key-store-os.test.ts under a python pty. Kept as its
// own file because it must run as a fresh process with a controlling terminal —
// something the vitest worker cannot give itself.
import { createPassportCredentialStore } from "../../cli/passport-key-store.mjs";

const passportId = `pc-pty-${process.pid}-${Date.now()}`;
const secret = "private-key-material-that-must-survive-a-round-trip";
const store = createPassportCredentialStore();

try {
  const written = store.write(passportId, secret);
  const readback = store.read(passportId);
  if (written.ok && readback.ok && readback.secret === secret) {
    console.log("ROUND_TRIP_OK");
  } else {
    console.log(`ROUND_TRIP_FAILED written=${written.ok} read=${readback.ok} match=${readback.secret === secret}`);
  }
} finally {
  store.delete(passportId);
}
