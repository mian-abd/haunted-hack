import { afterAll, beforeEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

// Fake actor + stubbed fetch, like server.test.ts. Env must be set before the modules load.
process.env.TERSE_FAKE = "1"
process.env.CARE_TEAM_URL = "http://care.test"
const { handle } = await import("./server")
const { elder } = await import("./actor")
const { autoDialOnce } = await import("./elevenlabs")

const ID = "grandpa-joe"
const SECRET = "tool-secret-for-tests"
const HOOK_SECRET = "webhook-secret-for-tests"
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit }[] = []
let elevenLabs = () => Response.json({ success: true, message: "ok", conversation_id: "conv_1", callSid: "CA1" })

beforeEach(async () => {
  calls = []
  delete process.env.SUPABASE_URL // bun test loads server/.env: never the real database here
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.AUTO_DIAL
  elevenLabs = () => Response.json({ success: true, message: "ok", conversation_id: "conv_1", callSid: "CA1" })
  Object.assign(process.env, {
    ELEVENLABS_API_KEY: "xi-test", ELEVENLABS_AGENT_ID: "agent_test", ELEVENLABS_PHONE_NUMBER_ID: "phnum_test",
    ELDER_PHONE: "+15550000000", EL_TOOL_SECRET: SECRET, ELEVENLABS_WEBHOOK_SECRET: HOOK_SECRET,
  })
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return String(url).startsWith("https://api.elevenlabs.io") ? elevenLabs() : new Response("{}", { status: 202 })
  }) as typeof fetch
  expect((await post("/api/demo/reset", { elderId: ID })).status).toBe(200)
  calls = []
})
afterAll(() => { globalThis.fetch = realFetch })

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  handle(new Request(`http://server.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }))
const state = () => elder(ID).getState()
const outbound = () => calls.filter(c => c.url === "https://api.elevenlabs.io/v1/convai/twilio/outbound-call")
const escalations = () => calls.filter(c => c.url === "http://care.test/escalate").map(c => JSON.parse(String(c.init.body)))
const signed = (body: string, t = Math.floor(Date.now() / 1000), secret = HOOK_SECRET) =>
  ({ "ElevenLabs-Signature": `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}` })

test("dial places the outbound call with the elder's details and marks the call started", async () => {
  const res = await post("/api/call/dial", { elderId: ID })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ conversationId: "conv_1", callSid: "CA1" })

  expect(outbound()).toHaveLength(1)
  const { init } = outbound()[0]
  expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-test")
  const body = JSON.parse(String(init.body))
  expect(body).toMatchObject({ agent_id: "agent_test", agent_phone_number_id: "phnum_test", to_number: "+15550000000" })
  const vars = body.conversation_initiation_client_data.dynamic_variables
  expect(vars.elder_id).toBe(ID)
  expect(vars.elder_first_name).toBe("Joe")
  expect(vars.elder_context).toContain("Amlodipine")

  const s = await state()
  expect(s.callState).toBe("in_progress")
  expect(s.timeline.at(-1)?.text).toBe("Calling Joe's phone")
  expect(JSON.stringify(s.timeline)).not.toContain("+1555") // the phone number never reaches the dashboard
})

test("dial refuses a second call while one is in progress", async () => {
  expect((await post("/api/call/dial", { elderId: ID })).status).toBe(200)
  const res = await post("/api/call/dial", { elderId: ID })
  expect(res.status).toBe(409)
  expect(outbound()).toHaveLength(1)
})

test("dial without ElevenLabs config answers 503 and calls nobody", async () => {
  delete process.env.ELDER_PHONE
  const res = await post("/api/call/dial", { elderId: ID })
  expect(res.status).toBe(503)
  expect((await res.json()).error).toContain("ELDER_PHONE")
  expect(outbound()).toHaveLength(0)
})

test("an ElevenLabs error is a 502 and leaves the call idle", async () => {
  elevenLabs = () => Response.json({ detail: [{ msg: "to_number is invalid" }] }, { status: 422 })
  const res = await post("/api/call/dial", { elderId: ID })
  expect(res.status).toBe(502)
  expect((await res.json()).error).toContain("to_number is invalid")
  expect((await state()).callState).toBe("idle")
})

test("tool webhooks need the shared secret", async () => {
  const args = { symptom: "dizzy", severity: "medium" }
  expect((await post("/api/el/tool/report_symptom", args)).status).toBe(401)
  expect((await post("/api/el/tool/report_symptom", args, { "x-unc-secret": "wrong" })).status).toBe(401)
  delete process.env.EL_TOOL_SECRET
  expect((await post("/api/el/tool/report_symptom", args, { "x-unc-secret": SECRET })).status).toBe(503)
  expect(escalations()).toHaveLength(0)
})

test("a tool webhook runs the same tool as the browser call", async () => {
  const res = await post("/api/el/tool/report_symptom", { symptom: "dizzy", severity: "medium", elder_id: ID }, { "x-unc-secret": SECRET })
  expect(res.status).toBe(200)
  expect((await res.json()).output).toBe("Logged symptom: dizzy (medium). Care team notified.")
  expect(escalations()).toEqual([{ elderId: ID, kind: "symptom", reason: "dizzy", details: { severity: "medium", missedMeds: [] } }])
  expect((await state()).timeline.at(-1)).toMatchObject({ kind: "symptom", text: "dizzy" })
})

test("a tool webhook without elder_id uses the demo elder, and bad args come back as output", async () => {
  const ok = await post("/api/el/tool/request_refill", { med: "Amlodipine" }, { "x-unc-secret": SECRET })
  expect((await ok.json()).output).toBe("Refill request sent to the pharmacy for Amlodipine.")
  expect(escalations()[0]).toMatchObject({ elderId: ID, kind: "refill" })

  const badArgs = await post("/api/el/tool/confirm_medication", { med: "Amlodipine" }, { "x-unc-secret": SECRET })
  expect(badArgs.status).toBe(400)
  expect((await badArgs.json()).output).toBe("Error: taken must be true or false")
})

test("post-call webhook checks the signature", async () => {
  const body = JSON.stringify({ type: "post_call_transcription", data: { analysis: { transcript_summary: "ok" } } })
  expect((await post("/api/el/post-call", body)).status).toBe(401)
  expect((await post("/api/el/post-call", body, signed(body, undefined, "other-secret"))).status).toBe(401)
  expect((await post("/api/el/post-call", body, signed(body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401)
})

test("post-call transcription logs the recap and closes a call the agent left open", async () => {
  await post("/api/call/dial", { elderId: ID })
  const body = JSON.stringify({
    type: "post_call_transcription",
    data: { conversation_id: "conv_1", transcript: [{}, {}, {}], analysis: { transcript_summary: "Joe is dizzy and out of Amlodipine." },
      conversation_initiation_client_data: { dynamic_variables: { elder_id: ID } } },
  })
  const res = await post("/api/el/post-call", body, signed(body))
  expect(res.status).toBe(200)
  const s = await state()
  expect(s.callState).toBe("idle")
  expect(s.timeline.map(e => e.text)).toContain("Call recap: Joe is dizzy and out of Amlodipine.")
  expect(s.timeline.at(-1)).toMatchObject({ kind: "call_ended", text: "Joe is dizzy and out of Amlodipine." })
})

test("a call that never connects is closed with the reason", async () => {
  await post("/api/call/dial", { elderId: ID })
  const body = JSON.stringify({ type: "call_initiation_failure", data: { failure_reason: "no-answer" } })
  expect((await post("/api/el/post-call", body, signed(body))).status).toBe(200)
  const s = await state()
  expect(s.callState).toBe("idle")
  expect(s.timeline.at(-1)?.text).toBe("The check-in call did not connect (no-answer).")
})

test("auto-dial rings the phone once the alarm makes a call due, and backs off after a failure", async () => {
  expect(await autoDialOnce(ID)).toBe("skipped") // nothing due yet
  await post("/api/demo/schedule", { elderId: ID, inSeconds: 0 })
  await Bun.sleep(20)
  expect((await state()).callState).toBe("due")
  expect(await autoDialOnce(ID)).toBe("dialed")
  expect((await state()).callState).toBe("in_progress")
  expect(await autoDialOnce(ID)).toBe("skipped") // the call is in progress now

  await post("/api/demo/reset", { elderId: ID })
  await post("/api/demo/schedule", { elderId: ID, inSeconds: 0 })
  await Bun.sleep(20)
  elevenLabs = () => Response.json({ detail: "down" }, { status: 500 })
  const now = Date.now()
  expect(await autoDialOnce(ID, now)).toBe("failed")
  expect(await autoDialOnce(ID, now + 30_000)).toBe("skipped")
  elevenLabs = () => Response.json({ success: true, message: "ok", conversation_id: "conv_2", callSid: "CA2" })
  expect(await autoDialOnce(ID, now + 61_000)).toBe("dialed")
})

test("call mode tells web/ whether Start check-in rings the phone", async () => {
  const mode = async () => (await handle(new Request(`http://server.test/api/call/mode?elderId=${ID}`))).json()
  process.env.AUTO_DIAL = "1"
  expect(await mode()).toEqual({ phone: true, autoDial: true })
  delete process.env.AUTO_DIAL
  delete process.env.ELDER_PHONE
  expect(await mode()).toEqual({ phone: false, autoDial: false })
})

test("a recheck call tells the agent it is a follow-up", async () => {
  const { elderContext } = await import("./elevenlabs")
  const s = await elder(ID).getState()
  expect(elderContext(s)).not.toContain("follow-up")
  await elder(ID).setStatus("watch", "Dizzy after missing Amlodipine")
  expect(elderContext(await elder(ID).getState())).toContain("This is a follow-up call")
})

// The actor defers a recheck that comes due mid-call; the server also refuses to ring a live phone call again, in case an
// older actor (or anything else) marks a call due while the phone is still connected.
test("the server never rings the phone again while its call is live; the call's end frees it", async () => {
  expect((await post("/api/call/dial", { elderId: ID })).status).toBe(200)
  await elder(ID).endCall("ended on the actor only") // the actor no longer says in_progress...
  const again = await post("/api/call/dial", { elderId: ID })
  expect(again.status).toBe(409) // ...but the phone call is still live
  expect((await again.json()).error).toBe("a phone call is already in progress")
  expect(outbound()).toHaveLength(1)

  const body = JSON.stringify({ type: "post_call_transcription", data: { analysis: { transcript_summary: "done" } } })
  expect((await post("/api/el/post-call", body, signed(body))).status).toBe(200) // the post-call webhook ends it
  expect((await post("/api/call/dial", { elderId: ID })).status).toBe(200)
  expect(outbound()).toHaveLength(2)
})
