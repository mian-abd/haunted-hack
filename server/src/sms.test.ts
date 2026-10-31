import { afterAll, beforeEach, expect, test } from "bun:test"

// The after-call text: fake actor, stubbed Twilio and OpenAI. Env must be set before the modules load.
process.env.TERSE_FAKE = "1"
process.env.CARE_TEAM_URL = "http://care.test"
const { handle } = await import("./server")
const { elder } = await import("./actor")
const { textRecap } = await import("./elevenlabs")
const { recapText } = await import("./sms")

const ID = "grandpa-joe"
const realFetch = globalThis.fetch
let twilio: { url: string; auth: string; form: URLSearchParams }[] = []
let twilioAnswer = () => Response.json({ sid: "SM123" }, { status: 201 })
let openai = () => Response.json({ choices: [{ message: { content: "You told me you felt dizzy and ran out of your blood-pressure pills. Your refill is being readied." } }] })

beforeEach(async () => {
  twilio = []
  twilioAnswer = () => Response.json({ sid: "SM123" }, { status: 201 })
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"]) delete process.env[k]
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+16810000000", ELDER_PHONE: "+15550000000" })
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    if (u.startsWith("https://api.twilio.com/")) {
      twilio.push({ url: u, auth: String((init.headers as Record<string, string>).authorization), form: new URLSearchParams(String(init.body)) })
      return twilioAnswer()
    }
    if (u.startsWith("https://api.openai.com/")) return openai()
    return new Response("{}", { status: 202 })
  }) as typeof fetch
  await handle(new Request("http://server.test/api/demo/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ elderId: ID }) }))
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "ELDER_PHONE", "OPENAI_API_KEY"]) delete process.env[k]
})

test("after a call, the person on the phone gets a recap text from our Twilio number", async () => {
  const d = { conversation_id: "conv_a", metadata: { phone_call: { external_number: "+14155550123" } } }
  expect(await textRecap(ID, d, "Joe reported dizziness and was out of Amlodipine; a refill was requested.")).toBe("sent")
  expect(twilio).toHaveLength(1)
  expect(twilio[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json")
  expect(twilio[0].auth).toBe(`Basic ${btoa("AC_test:tok")}`)
  expect(twilio[0].form.get("To")).toBe("+14155550123") // the call's own number
  expect(twilio[0].form.get("From")).toBe("+16810000000")
  expect(twilio[0].form.get("Body")).toStartWith("Hi Joe, it's Troska. Here's a recap of our call: Joe reported dizziness")
  expect((await elder(ID).getState()).timeline.at(-1)?.text).toBe("Texted Joe a recap of the call")
})

test("the recap speaks to the elder when OpenAI is set, and says when Troska calls next", async () => {
  process.env.OPENAI_API_KEY = "sk-test"
  const text = await recapText("Joe", "Joe reported dizziness.", Date.parse("2026-10-31T23:30:00Z"))
  expect(text).toBe("Hi Joe, it's Troska. You told me you felt dizzy and ran out of your blood-pressure pills. Your refill is being readied. I'll call you again Saturday 4:30 PM. You can call this number anytime. - Troska")
})

test("one text per call, even when ElevenLabs retries the webhook; no Twilio setup means no text", async () => {
  const d = { conversation_id: "conv_b" }
  expect(await textRecap(ID, d, "ok")).toBe("sent")
  expect(await textRecap(ID, d, "ok")).toBe("skipped")
  expect(twilio[0].form.get("To")).toBe("+15550000000") // no call metadata: ELDER_PHONE for the demo elder
  delete process.env.TWILIO_AUTH_TOKEN
  expect(await textRecap(ID, { conversation_id: "conv_c" }, "ok")).toBe("skipped")
  expect(twilio).toHaveLength(1)
})

test("a text Twilio refuses is logged on the timeline with Twilio's reason", async () => {
  twilioAnswer = () => Response.json({ code: 30034, message: "Message from an unregistered number" }, { status: 400 })
  expect(await textRecap(ID, { conversation_id: "conv_d" }, "ok")).toBe("failed")
  expect((await elder(ID).getState()).timeline.at(-1)?.text).toBe("The recap text to Joe was not sent: Twilio 400 (error 30034): Message from an unregistered number")
})
