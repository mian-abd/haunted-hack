// Phone check-in through ElevenLabs (PLAN.md "ElevenLabs agent"): the agent calls Grandpa from our Twilio number and
// runs the same five tools as the browser call, as webhook tools. This file places the call, takes the agent's tool
// webhooks and its post-call webhook, and (AUTO_DIAL=1) dials whenever the actor's alarm makes a call due.
import { createHmac, timingSafeEqual } from "node:crypto"
import { elder, type ElderState } from "./actor"
import { archiveTranscript, historyFor, linkPhone, newCallerProfile, patientById, patientByPhone, recordFor, samePhone } from "./store"

type Body = Record<string, any>
export type Deps = {
  runTool: (elderId: string, name: string, args: Body) => Promise<string>
  endCall: (elderId: string, summary: string, mood?: string) => Promise<void>
}

const API = "https://api.elevenlabs.io/v1/convai"
const env = (k: string) => process.env[k]?.trim() ?? ""
const fail = (msg: string, status = 400): never => { throw Object.assign(new Error(msg), { status }) }
export const defaultElder = () => env("ELDER_ID") || "grandpa-joe"

// The elder-specific half of the agent prompt, sent as the {{elder_context}} dynamic variable.
// Mirrors buildInstructions() in web/src/voice.ts; the fixed half lives on the agent (scripts/elevenlabs-agent.ts).
export function elderContext(s: ElderState): string {
  const p = s.profile
  const first = p?.name.split(" ")[0] ?? "there"
  const teach = s.meds.find(m => m.times.length > 1) ?? s.meds[0]
  const meds = s.meds.map(m =>
    `- ${m.name} ${m.dose} at ${m.times.join(" and ")}, for ${m.purpose}${m.missedCount ? ` (missed ${m.missedCount} time(s) recently)` : ""}`)
  return [
    `You are talking with ${p ? `${p.name}${p.age ? `, age ${p.age}` : ""}` : "an older adult"}. Call them ${first}.`,
    p?.conditions?.length && `Conditions: ${p.conditions.join(", ")}.`,
    p?.family?.name && `Family contact: ${p.family.name}${p.family.relation ? ` (${p.family.relation})` : ""}.`,
    `Current status: ${s.status}${s.statusReason ? `, because: ${s.statusReason}` : ""}.`,
    s.status !== "ok" && `This is a follow-up call the care team asked for. Early on, ask whether that is better, the same or worse, and call report_symptom if it is not better.`,
    meds.length && `Medicines due today:\n${meds.join("\n")}`,
    teach && `Teach-back medicine: ${teach.name}.`,
  ].filter(Boolean).join("\n")
}

// {{elder_context}} for a call: the actor's live state plus the person's history from Supabase (earlier calls and
// symptoms), so the agent remembers them across calls, phone numbers and restarts.
export async function contextFor(elderId: string, s: ElderState, extra: (string | false)[] = []): Promise<string> {
  return [elderContext(s), ...(await historyFor(elderId)), ...extra].filter(Boolean).join("\n")
}

// GET /api/call/mode: tells web/ whether "Start check-in" rings the phone or opens the browser call.
export const callMode = () => ({
  phone: ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID", "ELDER_PHONE"].every(k => env(k)),
  autoDial: env("AUTO_DIAL") === "1",
})

const dialing = new Set<string>()
// Phone calls in flight, per elder. The actor's alarm can fire mid-call (an urgent recheck comes after 60 s) and mark a
// new call due; that must not ring the phone a second time. Auto-dial retries after the call ends (end_call, the
// post-call webhook or a demo reset), so the recheck still happens. A stale entry expires after 15 minutes.
const onPhone = new Map<string, number>()
export const phoneCallEnded = (elderId: string) => { onPhone.delete(elderId) }

// The agent's opening line ({{greeting}}): a scheduled check-in, a recheck the care team asked for, or the elder calling us.
export function greeting(s: ElderState, inbound = false): string {
  const first = s.profile?.name.split(" ")[0] ?? "there"
  if (inbound) return `Hi ${first}, it's Troska. Thanks for calling. What can I do for you?`
  if (s.status !== "ok") return `Hi ${first}, it's Troska calling back to check on you. How are you feeling now?`
  return `Hi ${first}, it's Troska calling for your check-in. How are you feeling today?`
}

// POST /api/call/dial: ElevenLabs places the call from our Twilio number, then the actor marks the call started.
export async function dial(elderId: string): Promise<{ conversationId: string | null; callSid: string | null }> {
  const [key, agent, phone] = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID"].map(env)
  if (!key || !agent || !phone) fail("phone calls need ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID in server/.env", 503)
  // The number to ring: the elder's own phone from their Supabase profile, else ELDER_PHONE for the demo elder.
  const onFile = (await patientById(elderId))?.phone as string | undefined
  const to = onFile || (elderId === defaultElder() ? env("ELDER_PHONE") : "")
  if (!to) fail(`no phone number on file for ${elderId}: set ELDER_PHONE, or patients.phone in Supabase`, 503)
  if (!onFile) void linkPhone(elderId, to)
  if (dialing.has(elderId)) fail("already dialing", 409)
  if (Date.now() - (onPhone.get(elderId) ?? 0) < 15 * 60_000) fail("a phone call is already in progress", 409)
  const actor = elder(elderId)
  const s = await actor.getState()
  if (s.callState === "in_progress") fail("a call is already in progress", 409)
  dialing.add(elderId)
  try {
    const first = s.profile?.name.split(" ")[0] ?? "there"
    const r = await fetch(`${API}/twilio/outbound-call`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agent,
        agent_phone_number_id: phone,
        to_number: to,
        conversation_initiation_client_data: { dynamic_variables: { elder_id: elderId, elder_first_name: first, elder_context: await contextFor(elderId, s), greeting: greeting(s) } },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const out: Body = await r.json().catch(() => ({}))
    if (!r.ok || out.success === false) fail(`ElevenLabs call failed (${r.status}): ${out.message ?? out.detail?.[0]?.msg ?? out.detail ?? "no details"}`, 502)
    onPhone.set(elderId, Date.now())
    await actor.startCall()
    await actor.logEvent({ kind: "note", from: "system", text: `Calling ${first}'s phone`, data: { conversationId: out.conversation_id ?? null } })
    return { conversationId: out.conversation_id ?? null, callSid: out.callSid ?? null }
  } finally {
    dialing.delete(elderId)
  }
}

// POST /api/el/tool/:name and POST /api/el/post-call. Both are public through the tunnel, so both are authenticated.
export async function webhook(req: Request, pathname: string, deps: Deps): Promise<Response> {
  if (req.method !== "POST") fail("not found", 404)
  const raw = await req.text()
  if (pathname === "/api/el/post-call") return postCall(req, raw, deps)
  if (pathname === "/api/el/init") return inbound(req, raw)
  const name = pathname.match(/^\/api\/el\/tool\/([a-z_]+)$/)?.[1] ?? fail("not found", 404)
  sameSecret(req.headers.get("x-unc-secret"), env("EL_TOOL_SECRET"), "EL_TOOL_SECRET")
  let args: Body
  try { args = raw ? JSON.parse(raw) : {} } catch { return fail("body must be JSON") }
  const { elder_id, ...rest } = args // the agent fills elder_id from the {{elder_id}} dynamic variable
  const elderId = typeof elder_id === "string" && elder_id.trim() ? elder_id : defaultElder()
  return Response.json({ output: await deps.runTool(elderId, name, rest) })
}

// POST /api/el/init: someone calls our Twilio number. While it rings, ElevenLabs asks here who is calling; without the
// agent's dynamic variables it drops the call ("Missing required dynamic variables"). The caller's phone number finds
// their profile in Supabase (or ELDER_PHONE, the demo elder). A number we have not met gets a new profile, and the agent
// asks who they are and saves it (save_profile), so the next call from that number knows them and their history.
async function inbound(req: Request, raw: string): Promise<Response> {
  sameSecret(req.headers.get("x-unc-secret"), env("EL_TOOL_SECRET"), "EL_TOOL_SECRET")
  let b: Body
  try { b = raw ? JSON.parse(raw) : {} } catch { return fail("body must be JSON") }
  const caller = String(b.caller_id ?? "")
  const row = await patientByPhone(caller)
  let elderId = row?.id as string | undefined
  let known = !!elderId
  if (!elderId && samePhone(caller, env("ELDER_PHONE"))) { elderId = defaultElder(); known = true; void linkPhone(elderId, caller) }
  let fresh = known && row?.name === "New caller" // called before, but never told us who they are
  if (!elderId) { const id = await newCallerProfile(caller); if (id) { elderId = id; known = fresh = true } }
  elderId ??= defaultElder() // no Supabase: the demo elder, and the agent confirms who is speaking
  const actor = elder(elderId)
  let s = await actor.getState()
  if (!s.profile && !fresh) { const rec = await recordFor(elderId); if (rec) { await actor.setup(...rec); s = await actor.getState() } }
  const first = fresh ? "there" : s.profile?.name.split(" ")[0] ?? "there"
  onPhone.set(elderId, Date.now())
  if (s.callState !== "in_progress") await actor.startCall()
  await actor.logEvent({ kind: "note", from: "elder", text: fresh ? "A new caller called Troska" : `${first} called Troska`, data: { conversationId: b.conversation_id ?? null, inbound: true, knownNumber: known } })
  const context = fresh
    ? [
        "This caller is new: we do not know who they are yet. Introduce Troska as a care companion that checks in by phone. Ask their name, their age, their health conditions, the medicines they take and a family contact, and call save_profile each time you learn something. Then help with what they called about.",
        ...(await historyFor(elderId)),
      ].join("\n")
    : await contextFor(elderId, s, [
        `${first} called you this time. Ask what they need and help with that first, then do the check-in if there is time.`,
        !known && `The call came from a number that is not on file for ${first}. Confirm you are speaking with ${first} before you discuss anything personal.`,
      ])
  return Response.json({
    type: "conversation_initiation_client_data",
    dynamic_variables: { elder_id: elderId, elder_first_name: first, elder_context: context, greeting: fresh ? "Hi, this is Troska, a care companion. Who am I speaking with?" : greeting(s, true) },
  })
}

function sameSecret(got: string | null, want: string, name: string) {
  if (!want) fail(`${name} not set`, 503)
  const a = Buffer.from(got ?? ""), b = Buffer.from(want)
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail("bad or missing secret", 401)
}

// ElevenLabs signs post-call webhooks as `ElevenLabs-Signature: t=<unix s>,v0=<hex HMAC-SHA256 of "<t>.<body>">`.
export function verifySignature(header: string | null, raw: string, secret = env("ELEVENLABS_WEBHOOK_SECRET")) {
  if (!secret) fail("ELEVENLABS_WEBHOOK_SECRET not set", 503)
  const parts = Object.fromEntries((header ?? "").split(",").map(p => p.trim().split("=", 2)))
  if (!parts.t || Math.abs(Date.now() / 1000 - Number(parts.t)) > 30 * 60) fail("stale or missing signature", 401)
  sameSecret(`v0=${parts.v0 ?? ""}`, `v0=${createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex")}`, "signature")
}

// Logs the call summary, and closes the call if Grandpa hung up before the agent saved its summary.
async function postCall(req: Request, raw: string, deps: Deps): Promise<Response> {
  verifySignature(req.headers.get("elevenlabs-signature"), raw)
  let ev: Body
  try { ev = JSON.parse(raw) } catch { return fail("body must be JSON") }
  const d: Body = ev.data ?? {}
  const elderId = d.conversation_initiation_client_data?.dynamic_variables?.elder_id || defaultElder()
  phoneCallEnded(elderId) // the call is over, whatever the event
  const actor = elder(elderId)
  let summary: string | null = null
  if (ev.type === "post_call_transcription") {
    summary = d.analysis?.transcript_summary || "Phone check-in finished."
    await actor.logEvent({ kind: "note", from: "system", text: `Call recap: ${summary}`, data: { conversationId: d.conversation_id ?? null, turns: d.transcript?.length ?? 0 } })
  } else if (ev.type === "call_initiation_failure") {
    summary = `The check-in call did not connect (${d.failure_reason ?? "unknown reason"}).`
    await actor.logEvent({ kind: "note", from: "system", text: summary, data: { conversationId: d.conversation_id ?? null } })
  }
  if (summary && (await actor.getState()).callState === "in_progress") await deps.endCall(elderId, summary)
  if (ev.type === "post_call_transcription") await archiveTranscript(elderId, summary!, Array.isArray(d.transcript) ? d.transcript : [], d.conversation_id ?? null)
  return Response.json({ ok: true })
}

// AUTO_DIAL=1: dial whenever the actor says a call is due (its alarm fired). Polling, like web/'s fallback, keeps
// working across actor restarts; a failed dial waits a minute before retrying so a bad config cannot spam calls.
const retryAt = new Map<string, number>()

export async function autoDialOnce(elderId: string, now = Date.now()): Promise<"dialed" | "skipped" | "failed"> {
  if (now < (retryAt.get(elderId) ?? 0)) return "skipped"
  const s = await elder(elderId).getState().catch(() => null)
  if (s?.callState !== "due") return "skipped"
  try {
    await dial(elderId)
    retryAt.delete(elderId)
    console.log(`[auto-dial] ${elderId}: calling`)
    return "dialed"
  } catch (e: any) {
    retryAt.set(elderId, now + 60_000)
    console.warn(`[auto-dial] ${elderId}: ${e?.message ?? e}; retrying in 60 s`)
    return "failed"
  }
}

export function startAutoDial(elderIds = [defaultElder()], everyMs = 2000) {
  let busy = false
  return setInterval(async () => {
    if (busy) return
    busy = true
    try { for (const id of elderIds) await autoDialOnce(id) } finally { busy = false }
  }, everyMs)
}
