// End-to-end check of the running demo: the real ElderActor, real OpenAI brains, real Agent Relay traffic.
// Start the stack with ./dev.sh, then run: bun e2e.ts   (PASS/FAIL per step with timings; exits 1 on any FAIL)
import { storyline } from "./web/src/script.ts"

const SERVER = "http://localhost:8787"
const CARE = "http://localhost:8788"
const ELDER = "grandpa-joe"
const MAX_TEXT = 240 // Care Feed cards must stay short
const TARGET_MS = 12_000 // symptom -> last hero message; FAIL when much over it

type Ev = { id: string; ts: number; kind: string; text: string; from?: string; to?: string; data?: Record<string, any> }

let failures = 0
const check = (step: string, ok: boolean, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  (${detail})` : ""}`)
}
const secs = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "missing")

async function api(path: string, body?: Record<string, unknown>): Promise<any> {
  const init = body && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elderId: ELDER, ...body }) }
  const res = await fetch(SERVER + path, init)
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`)
  return res.json()
}
const getState = () => api(`/api/state?elderId=${ELDER}`)
const health = () => fetch(`${CARE}/health`).then(r => r.json())

async function until<T>(get: () => T | Promise<T>, ms: number, every = 100): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(every)) {
    const v = await get()
    if (v) return v
  }
}

// One case per call (care-team): every escalation of the call joins one case, and each med is refilled once.
const ofType = (msgs: Ev[], type: string) => msgs.filter(m => m.data?.type === type)
const kindsOf = (msgs: Ev[]) => ofType(msgs, "case").map(m => String(m.data!.kind)) // the caretaker posts one "case" message per escalation
// One family text per family request: the teach-back, the summary and the doctor's notify_family.
const familyWanted = (msgs: Ev[]) => kindsOf(msgs).filter(k => k === "teach_back" || k === "summary").length + (ofType(msgs, "decision")[0]?.data?.notifyFamily ? 1 : 0)
function done(msgs: Ev[]): boolean {
  const kinds = kindsOf(msgs), d = ofType(msgs, "decision")[0]
  return ["symptom", "teach_back", "summary"].every(k => kinds.includes(k)) && !!d
    && (!(kinds.includes("refill") || d.data!.refillMed) || ofType(msgs, "refill_ready").length > 0) // the doctor's or request_refill's
    && ofType(msgs, "family_message").length >= familyWanted(msgs)
}

console.log(`Unc e2e · ${new Date().toISOString()}\n`)
const h0 = await health().catch(() => null)
if (!h0) {
  console.log("FAIL  care-team is not answering on :8788. Start the stack with ./dev.sh first.")
  process.exit(1)
}
check("0. care-team runs real brains on real Agent Relay", h0.brain === "openai" && h0.relay === "agent-relay" && h0.actor === "terse",
  `brain=${h0.brain} model=${h0.model} relay=${h0.relay} actor=${h0.actor}`)

// a. reset
const seed = await Bun.file(new URL("./supabase/seed.json", import.meta.url)).json()
const seedMeds: string[] = seed.prescriptions.filter((p: any) => p.patient_id === ELDER).map((p: any) => p.name)
let t = Date.now()
await api("/api/demo/reset", {})
let s = await getState()
check("a. reset: Joe Nguyen with his meds, status ok",
  s.profile?.name === "Joe Nguyen" && s.status === "ok" && s.timeline.length === 0 && seedMeds.every(n => s.meds.some((m: any) => m.name === n)),
  `${s.profile?.name}; ${s.meds.map((m: any) => `${m.name} ${m.dose}`).join(", ")}; status ${s.status}; ${Date.now() - t} ms`)

// b. actor socket + alarm
const { websocketUrl } = await api(`/api/actor-ws?elderId=${ELDER}`)
const socket: { at: number; m: any }[] = []
const ws = new WebSocket(websocketUrl)
ws.onmessage = e => { try { socket.push({ at: Date.now(), m: JSON.parse(String(e.data)) }) } catch {} }
const opened = await until(() => socket.find(x => x.m.type === "state"), 5000)
t = Date.now()
const { atMs } = await api("/api/demo/schedule", { inSeconds: 5 })
const due = await until(() => socket.find(x => x.m.type === "call_due"), 9000, 20)
check("b. actor socket gets call_due from the alarm", !!opened && !!due,
  due ? `call_due ${secs(due.at - t)} after scheduling 5 s, ${due.at - atMs} ms after the alarm time` : `no call_due within 9 s (socket state received: ${!!opened})`)

// c. the scripted-demo tool sequence (web/src/script.ts), through the server like the browser does
const tools = storyline(s).flatMap(step => ("tool" in step ? [step.tool] : []))
const firedAt: Record<string, number> = {}
const outputs: string[] = []
await api("/api/call/start", {})
for (const [name, args] of tools) {
  firedAt[name] ??= Date.now() // the server fires the escalation inside this request
  const r = await api("/api/tool", { name, args }).catch(e => ({ output: `Error: ${e.message}` }))
  outputs.push(`${name} ${JSON.stringify(args)} -> ${r.output}`)
  await Bun.sleep(1000) // a short pause between tools, like a brisk call
}
check("c. tool sequence via POST /api/tool", outputs.every(o => !o.includes("Error")), tools.map(([n]) => n).join(" > "))
for (const o of outputs) console.log(`      ${o}`)

// d. wait for the care team to finish the call's case, then the status change and the recheck
const agentMsgs = (st: any): Ev[] => st.timeline.filter((e: Ev) => e.kind === "agent_msg")
const settled = await until(async () => {
  const st = await getState()
  const m = agentMsgs(st)
  return done(m) && st.status !== "ok" && (!ofType(m, "decision")[0]!.data!.recheck || st.nextCheckInAt) ? st : undefined
}, 90_000, 250)
s = settled ?? await getState()
const msgs = agentMsgs(s)
const kinds = kindsOf(msgs)
const t0 = firedAt.report_symptom!
console.log(`\n      Agent thread (+seconds after report_symptom):`)
for (const m of msgs) console.log(`      +${((m.ts - t0) / 1000).toFixed(1).padStart(5)} [${m.data?.lane}] ${m.from} -> ${m.to} (${m.data?.type}): ${m.text}`)
console.log()

check("d. care team finished the call's case", !!settled, settled ? `escalations: ${kinds.join(", ")}` : "timed out after 90 s")
const lanes = ["doctor", "pharmacy", "family"].map(l => `${l} ${msgs.filter(m => m.data?.lane === l).length}`)
check("d. agent_msg events in all three lanes", lanes.every(l => !l.endsWith(" 0")), lanes.join(", "))
const h1 = await health()
check("d. written by the real LLM (no mock fallback)", h1.brain === "openai" && h1.fallbacks === h0.fallbacks,
  `model ${h1.model}, OpenAI fallbacks during the run: ${h1.fallbacks - h0.fallbacks}`)
check("d. carried by real Agent Relay", msgs.length > 0 && msgs.every(m => m.data?.relay === "agent-relay" && m.data?.relayId),
  `${msgs.length} messages, each with an Agent Relay message id, e.g. ${msgs[0]?.data?.relayId}`)
check("d. status moves to watch with a reason", s.status === "watch" && !!s.statusReason, `${s.status}: ${s.statusReason}`)
check("d. recheck scheduled (nextCheckInAt)", typeof s.nextCheckInAt === "number" && s.nextCheckInAt > Date.now(),
  s.nextCheckInAt ? `fires in ${secs(s.nextCheckInAt - Date.now())}` : "not set")
const unreadable = msgs.filter(m => !m.text.trim() || m.text.length > MAX_TEXT || /[{}[\]]|"\w+"\s*:/.test(m.text))
check(`d. texts short and plain (<= ${MAX_TEXT} chars, no JSON)`, unreadable.length === 0,
  unreadable.length ? unreadable.map(m => `${m.from} ${m.text.length} chars`).join("; ") : `longest ${Math.max(0, ...msgs.map(m => m.text.length))} chars`)

// e. one case per call: one thread, each escalation once, request_refill handled, each med readied once,
// one family text per family request, no lane item outside the relay
const caseIds = new Set(msgs.map(m => m.data?.caseId))
const ready = ofType(msgs, "refill_ready").map(m => String(m.data?.med ?? "").split(" ")[0]!.toLowerCase())
const viaDoctor = ofType(msgs, "refill_request").length > 0 // the doctor ordered it; one case per call then skips request_refill's duplicate
const family = ofType(msgs, "family_message").length
const stray = s.timeline.filter((e: Ev) => e.kind !== "agent_msg" && e.data?.lane)
check("e. one case per call, no duplicate lane items",
  caseIds.size === 1 && new Set(kinds).size === kinds.length && (kinds.includes("refill") || viaDoctor) && ofType(msgs, "decision").length === 1
    && new Set(ready).size === ready.length && family === familyWanted(msgs) && !stray.length,
  `${caseIds.size} case(s); escalations ${kinds.join(", ")}; refill ordered by ${viaDoctor ? "the doctor" : "request_refill"}, ready: ${ready.join(", ") || "none"}; family texts ${family}/${familyWanted(msgs)}; server-written lane items ${stray.length}`)

// f. latency per hop, measured from the tool call that triggered it
const at = (type: string, after = t0) => msgs.find(m => m.data?.type === type && m.ts >= after)?.ts ?? NaN
const caseAt = (kind: string) => msgs.find(m => m.data?.type === "case" && m.data.kind === kind)?.ts ?? NaN
const hops: [string, number][] = [
  ["report_symptom -> caretaker hands off to doctor", caseAt("symptom") - t0],
  ["report_symptom -> doctor decision", at("decision") - t0],
  ["report_symptom -> status set on the actor", (s.timeline.find((e: Ev) => e.kind === "status")?.ts ?? NaN) - t0],
  ["report_symptom -> first family message", at("family_message") - t0],
  viaDoctor ? ["report_symptom -> refill ready (doctor -> pharmacy)", at("refill_ready") - t0]
    : ["request_refill -> refill ready (pharmacy)", at("refill_ready", firedAt.request_refill!) - firedAt.request_refill!],
  ["teach_back_result -> next family message", at("family_message", caseAt("teach_back")) - firedAt.teach_back_result!],
  ["end_call -> next family message", at("family_message", caseAt("summary")) - firedAt.end_call!],
]
console.log(`\n      Latency (model ${h1.model}):`)
for (const [label, ms] of hops) console.log(`      ${label.padEnd(52)} ${secs(ms)}`)
// Total: from the first tool call until the doctor, pharmacy and family lanes all have their answer.
const total = Math.max(at("decision"), at("family_message"), at("refill_ready")) - t0
check(`f. symptom -> doctor, pharmacy and family answered, near ${TARGET_MS / 1000} s`, Number.isFinite(total) && total <= TARGET_MS * 1.25, `total ${secs(total)}`)

ws.close()
console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL PASS")
process.exit(failures ? 1 : 0)
