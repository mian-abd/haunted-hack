// After every phone call, a short text to the person Troska talked with: what it heard and when it calls next.
// Sent from our Twilio number with the Twilio REST API, only when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM
// are set. US carriers block texts from unregistered long-code numbers (Twilio error 30034, A2P 10DLC), and a trial
// account can text only verified numbers: Twilio's answer is logged on the timeline either way.
const env = (k: string) => process.env[k]?.trim() ?? ""

export const smsReady = () => ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"].every(k => env(k))

const at = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", hour: "numeric", minute: "2-digit" })

/**
 * The text: the call's summary as two warm sentences to the elder ("you"), plus the next check-in. OpenAI rewrites the
 * summary (it is written for the care team, in the third person); without a key, or if that fails, a plain template.
 */
export async function recapText(first: string, summary: string, nextCheckInAt: number | null): Promise<string> {
  let body = ""
  const key = env("OPENAI_API_KEY")
  if (key) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: env("OPENAI_MODEL") || "gpt-6-luna",
          messages: [
            { role: "system", content: "Rewrite this phone-call summary as a text message to the older adult the call was with. Two short, warm sentences in plain words, speaking to them as \"you\". Use only facts from the summary, add no advice, no greeting, no sign-off, no emojis, under 260 characters." },
            { role: "user", content: summary },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok) body = String((await r.json()).choices?.[0]?.message?.content ?? "").trim()
    } catch {}
  }
  if (!body) body = `Here's a recap of our call: ${summary.slice(0, 240)}${summary.length > 240 ? "…" : ""}`
  const next = nextCheckInAt ? ` I'll call you again ${at(nextCheckInAt)}.` : ""
  return `Hi ${first}, it's Troska. ${body}${next} You can call this number anytime. - Troska`
}

/** One text through Twilio. Returns Twilio's message sid, or its error, so the caller can log the outcome. */
export async function sendSms(to: string, body: string): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const sid = env("TWILIO_ACCOUNT_SID")
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${sid}:${env("TWILIO_AUTH_TOKEN")}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: env("TWILIO_FROM"), Body: body }),
      signal: AbortSignal.timeout(10_000),
    })
    const out: Record<string, any> = await r.json().catch(() => ({}))
    return r.ok ? { ok: true, sid: String(out.sid) } : { ok: false, error: `Twilio ${r.status}${out.code ? ` (error ${out.code})` : ""}: ${out.message ?? "no details"}` }
  } catch (e: any) {
    return { ok: false, error: `Twilio unreachable: ${e?.message ?? e}` }
  }
}
