// The gateway's JSON error bodies. Shared by every data-plane route so an agent
// sees one error shape whichever door or destination it used.
export function err(status: number, code: string) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errMessage(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
