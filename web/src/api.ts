// Same origin by default: the Vite proxy forwards /api to server/, so a public tunnel URL works for everyone.
export const SERVER: string = import.meta.env.VITE_SERVER_URL ?? ""
export const ELDER = "grandpa-joe"
/** ?mock=1 renders from a local fixture: no server, no mic, POSTs become no-ops. */
export const MOCK = typeof location !== "undefined" && new URLSearchParams(location.search).has("mock")

/** Team access code for tunnel visitors: open the link once with ?key=…, and it is remembered on this device. */
const KEY: string = (() => {
  if (typeof location === "undefined") return ""
  const k = new URLSearchParams(location.search).get("key")
  try {
    if (k) localStorage.setItem("unc-key", k)
    return k ?? localStorage.getItem("unc-key") ?? ""
  } catch { return k ?? "" } // storage blocked (private mode): the key still works for this page load
})()
export const authHeaders = (): Record<string, string> => (KEY ? { "x-unc-key": KEY } : {})

export async function getJSON(path: string): Promise<any> {
  const r = await fetch(SERVER + path, { headers: authHeaders() })
  if (!r.ok) throw new Error(`${path.split("?")[0]} returned ${r.status}`)
  return r.json()
}

export async function post(path: string, body: Record<string, unknown>): Promise<any> {
  if (MOCK) return { output: "ok (mock mode)" }
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ elderId: ELDER, ...body }),
  })
  // err.body keeps the server's readable error, e.g. /api/tool's { output: "Error: severity must be ..." } for the voice model.
  if (!r.ok) throw Object.assign(new Error(`${path} returned ${r.status}`), { body: await r.json().catch(() => null) })
  return r.json().catch(() => ({})) // 202 with an empty body is fine
}
