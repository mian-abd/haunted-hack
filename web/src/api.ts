export const SERVER: string = import.meta.env.VITE_SERVER_URL || "http://localhost:8787"
export const ELDER = "grandpa-joe"
/** ?mock=1 renders from a local fixture: no server, no mic, POSTs become no-ops. */
export const MOCK = typeof location !== "undefined" && new URLSearchParams(location.search).has("mock")

export async function getJSON(path: string): Promise<any> {
  const r = await fetch(SERVER + path)
  if (!r.ok) throw new Error(`${path.split("?")[0]} returned ${r.status}`)
  return r.json()
}

export async function post(path: string, body: Record<string, unknown>): Promise<any> {
  if (MOCK) return { output: "ok (mock mode)" }
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ elderId: ELDER, ...body }),
  })
  if (!r.ok) throw new Error(`${path} returned ${r.status}`)
  return r.json().catch(() => ({})) // 202 with an empty body is fine
}
