// Honeypot field: hidden from real users (off-screen, aria-hidden, not
// tab-reachable, autocomplete off) but routinely auto-filled by dumb form bots.
// The server rejects any submission where this field is non-empty. Combined with
// the per-IP rate limiting on the auth actions, this filters most automated abuse
// without a paid CAPTCHA service (keeps the $0-budget constraint).
export function Honeypot() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: "-9999px",
        width: 1,
        height: 1,
        overflow: "hidden",
      }}
    >
      <label>
        Leave this field empty
        <input
          type="text"
          name="contact_phone"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </label>
    </div>
  );
}
