// Creates or updates the "Troska check-in" ElevenLabs agent (PLAN.md "ElevenLabs agent"): the phone prompt, its five
// webhook tools pointing at PUBLIC_URL, and the built-in end_call. With ELEVENLABS_PHONE_NUMBER_ID set, it also moves
// our Twilio number to this agent. Safe to re-run; run it again whenever the tunnel URL changes:
//   cd server && PUBLIC_URL=https://<tunnel> bun run el:setup
// Needs ELEVENLABS_API_KEY and EL_TOOL_SECRET (server/.env or the shell). Prints the agent id for server/.env.
import { elderContext, greeting } from "../src/elevenlabs"
import type { ElderState } from "../src/actor"

const NAME = "Troska check-in"
const SECRET_NAME = "unc_tool_secret"
const API = "https://api.elevenlabs.io/v1/convai"
const env = (k: string) => process.env[k]?.trim() ?? ""
const key = env("ELEVENLABS_API_KEY")
const publicUrl = env("PUBLIC_URL").replace(/\/+$/, "")
const toolSecret = env("EL_TOOL_SECRET")
if (!key || !publicUrl || !toolSecret) {
  console.error("Set ELEVENLABS_API_KEY, PUBLIC_URL (the https tunnel to :8787) and EL_TOOL_SECRET.")
  process.exit(1)
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(path.startsWith("/v1/") ? `https://api.elevenlabs.io${path}` : `${API}${path}`, { // "/v1/..." = outside convai
    method,
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : {}
}

// Fixed half of the prompt. The elder-specific half arrives per call as {{elder_context}} (src/elevenlabs.ts).
const PROMPT = `You are Troska, a warm care companion on a phone call with an older adult. Sometimes you call them for a check-in, and sometimes they call you.

{{elder_context}}

Memory: the context above can list earlier calls and symptoms from their record. Use it like someone who knows them: ask whether an earlier problem is better, and never ask again for things already on file. If they ask what happened last time, tell them from the earlier calls.

New callers: if the context says the caller is new, ask their name, age, health conditions, medicines and a family contact, one question at a time, and call save_profile each time you learn something. Never assume a caller is someone else on file.

Style: be warm and speak slowly. Use short sentences. Ask one question at a time, then wait for the answer. This is a phone call, so never use lists, markdown or emojis.

Medicines: go through each medicine due today. Ask whether they took it, and call confirm_medication once per medicine.

Teach-back: ask them to explain in their own words when and how they take the teach-back medicine. If they get it wrong, gently correct them and have them say it back. Then call teach_back_result (understood = whether they had it right the first time).

Symptoms: when they mention any symptom, call report_symptom. If they are out of a medicine or running low, offer a refill and call request_refill.

Tools: confirm_medication, report_symptom, teach_back_result, request_refill and save_profile run in the background. Call them and keep the conversation going in the same breath: acknowledge what they said and ask the next question. Never go quiet waiting for a tool.

Finish: give a short summary of what you heard and what happens next, call save_call_summary, say goodbye warmly, then call end_call to hang up.

Safety: never diagnose and never change doses. For danger signs (chest pain, trouble breathing, fainting, slurred speech, weakness on one side, a bad fall, an overdose or taking too much of any medicine or drug), FIRST call report_symptom with severity high, before you say anything else: it alerts the care team and the family right away. THEN tell them to call 911 right now, and stay calm and reassuring. Never skip that tool call in an emergency.`

const str = (description: string) => ({ type: "string", description })
const bool = (description: string) => ({ type: "boolean", description })
const elderId = { type: "string", dynamic_variable: "elder_id" } // filled by ElevenLabs, not the LLM

// ElevenLabs tool name → server tool (POST /api/el/tool/<server tool>). Ours can't be called end_call: that name is
// the agent's built-in hang-up.
const TOOLS: { name: string; path: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [
  { name: "confirm_medication", path: "confirm_medication", description: "Record whether the elder took one of their medicines today. Call once per medicine.",
    properties: { med: str("Medicine name as listed"), taken: bool("Whether they took it today"), note: str("Anything they said about it, e.g. ran out") }, required: ["med", "taken"] },
  { name: "report_symptom", path: "report_symptom", description: "Log a symptom the elder mentions. Use severity high for danger signs.",
    properties: { symptom: str("The symptom, in their words"), severity: { type: "string", enum: ["low", "medium", "high"], description: "low, medium, or high for danger signs" } }, required: ["symptom", "severity"] },
  { name: "teach_back_result", path: "teach_back_result", description: "Record whether the elder explained correctly, in their own words, when and how they take a medicine.",
    properties: { med: str("Medicine name"), understood: bool("Whether they had it right the first time"), note: str("What they got wrong and the correction") }, required: ["med", "understood"] },
  { name: "request_refill", path: "request_refill", description: "Ask the pharmacy to refill a medicine the elder is out of or low on.",
    properties: { med: str("Medicine name") }, required: ["med"] },
  { name: "save_profile", path: "save_profile", description: "Save what the caller tells you about themselves to their profile. Call it whenever you learn one of these; send only what you learned.",
    properties: { name: str("Their full name"), age: { type: "integer", description: "Their age in years" }, conditions: str("Health conditions, comma separated"),
      family_name: str("A family contact's name"), family_relation: str("How the family contact is related, e.g. daughter"), family_phone: str("The family contact's phone number") }, required: [] },
  { name: "save_call_summary", path: "end_call", description: "Save the closing summary of the check-in for the family and the doctor. Call it once, just before hanging up.",
    properties: { summary: str("2-3 sentences for the family and the doctor"), mood: str("Their mood, in a few words") }, required: ["summary", "mood"] },
]

// The shared secret travels as a stored ElevenLabs secret, so it never sits in plain text on the agent.
async function secretId(): Promise<string> {
  const { secrets = [] } = await api("GET", `/secrets?search=${SECRET_NAME}`)
  const found = secrets.find((s: any) => s.name === SECRET_NAME)
  if (found) return (await api("PATCH", `/secrets/${found.secret_id}`, { type: "update", name: SECRET_NAME, value: toolSecret })).secret_id ?? found.secret_id
  return (await api("POST", "/secrets", { type: "new", name: SECRET_NAME, value: toolSecret })).secret_id
}

async function upsertTools(secret: string): Promise<string[]> {
  const { tools: existing = [] } = await api("GET", "/tools?types=webhook&page_size=100")
  const ids: string[] = []
  for (const t of TOOLS) {
    const tool_config = {
      type: "webhook",
      name: t.name,
      description: t.description,
      response_timeout_secs: 20,
      // Record-keeping runs in the background so the agent keeps talking: waiting on the webhook left the elder in
      // silence after every fact (the model often said nothing after a tool result). Only the closing summary blocks,
      // because the call hangs up right after it; the agent always says something first.
      ...(t.name === "save_call_summary" ? { execution_mode: "immediate", pre_tool_speech: "force" } : { execution_mode: "async" }),
      api_schema: {
        url: `${publicUrl}/api/el/tool/${t.path}`,
        method: "POST",
        request_headers: { "x-unc-secret": { secret_id: secret } },
        request_body_schema: { type: "object", properties: { ...t.properties, elder_id: elderId }, required: [...t.required, "elder_id"] },
      },
    }
    const old = existing.find((x: any) => x.tool_config?.name === t.name && x.tool_config?.api_schema?.url?.includes("/api/el/tool/"))
    const saved = old ? await api("PATCH", `/tools/${old.id}`, { tool_config }) : await api("POST", "/tools", { tool_config })
    console.log(`${old ? "updated" : "created"} tool ${t.name} -> ${tool_config.api_schema.url}`)
    ids.push(saved.id)
  }
  return ids
}

// Default values for dynamic calls started without variables (e.g. "Test AI agent" in the dashboard): the seed elder.
async function placeholders(): Promise<Record<string, string>> {
  const seed = await Bun.file(new URL("../../supabase/seed.json", import.meta.url)).json()
  const p = seed.patients.find((x: any) => x.id === "grandpa-joe")
  const state: ElderState = {
    profile: { name: p.name, age: p.age, conditions: p.conditions, family: { name: p.family_name, relation: p.family_relation } },
    meds: seed.prescriptions.filter((r: any) => r.patient_id === p.id)
      .map((r: any) => ({ name: r.name, dose: r.dose, times: r.times, purpose: r.purpose, lastTakenAt: null, missedCount: 0 })),
    status: "ok", statusReason: "", callState: "idle", nextCheckInAt: null, timeline: [],
  }
  return { elder_id: p.id, elder_first_name: p.name.split(" ")[0], elder_context: elderContext(state), greeting: greeting(state) }
}

async function upsertAgent(toolIds: string[]): Promise<string> {
  const conversation_config = {
    agent: {
      first_message: "{{greeting}}", // set per call by the server: a check-in, a recheck, or the elder calling us
      language: "en",
      dynamic_variables: { dynamic_variable_placeholders: await placeholders() },
      prompt: {
        prompt: PROMPT,
        llm: env("ELEVENLABS_LLM") || "gemini-3.5-flash",
        temperature: 0.3,
        tool_ids: toolIds,
        built_in_tools: { end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } } },
      },
    },
    ...(env("ELEVENLABS_VOICE_ID") ? { tts: { voice_id: env("ELEVENLABS_VOICE_ID") } } : {}),
    conversation: { max_duration_seconds: 600 },
    turn: { speculative_turn: true }, // start the answer while the elder finishes their sentence: less dead air
  }
  let id = env("ELEVENLABS_AGENT_ID")
  if (!id) {
    const { agents = [] } = await api("GET", `/agents?search=${encodeURIComponent(NAME)}&page_size=50`)
    id = agents.find((a: any) => a.name === NAME)?.agent_id ?? ""
  }
  if (id) {
    await api("PATCH", `/agents/${id}`, { name: NAME, conversation_config })
    console.log(`updated agent ${NAME} (${id})`)
    return id
  }
  const created = await api("POST", "/agents/create", { name: NAME, tags: ["unc"], conversation_config })
  console.log(`created agent ${NAME} (${created.agent_id})`)
  return created.agent_id
}

// server/.env is git-ignored: the script keeps the agent id and the webhook secret there, so nobody copies them by hand.
const ENV_FILE = new URL("../.env", import.meta.url)
async function setEnv(name: string, value: string) {
  const file = Bun.file(ENV_FILE)
  const lines = (await file.exists() ? await file.text() : "").split(/\r?\n/).filter(l => l && !l.startsWith(`${name}=`))
  await Bun.write(ENV_FILE, [...lines, `${name}=${value}`].join("\n") + "\n")
}

// Two webhooks on the agent. Post-call (transcript + calls that never connected) → /api/el/post-call. Inbound calls:
// while the elder's call rings, ElevenLabs asks /api/el/init for the dynamic variables (without them it drops the call).
// Post-call webhook: ElevenLabs can't change a webhook's
// URL and shows its secret only once, so each new PUBLIC_URL gets a new webhook; the old ones are removed afterwards.
const HOOK_NAME = "Troska post-call"
async function agentWebhooks(agentId: string, secret: string) {
  const url = `${publicUrl}/api/el/post-call`
  const root = (method: string, path: string, body?: unknown) => api(method, `/v1/workspace/webhooks${path}`, body)
  const { webhooks = [] } = await root("GET", "")
  const ours = webhooks.filter((w: any) => w.name === HOOK_NAME)
  let id = ours.find((w: any) => w.webhook_url === url && !w.is_disabled)?.webhook_id
  if (id && env("ELEVENLABS_WEBHOOK_SECRET")) {
    console.log(`post-call webhook already points at ${url}`)
  } else {
    const created = await root("POST", "", { settings: { auth_type: "hmac", name: HOOK_NAME, webhook_url: url } })
    id = created.webhook_id
    await setEnv("ELEVENLABS_WEBHOOK_SECRET", created.webhook_secret)
    console.log(`created post-call webhook -> ${url} (secret saved to server/.env)`)
  }
  await api("PATCH", `/agents/${agentId}`, {
    platform_settings: {
      overrides: { enable_conversation_initiation_client_data_from_webhook: true },
      workspace_overrides: {
        webhooks: { post_call_webhook_id: id, events: ["transcript", "call_initiation_failure"] },
        conversation_initiation_client_data_webhook: { url: `${publicUrl}/api/el/init`, request_headers: { "x-unc-secret": { secret_id: secret } } },
      },
    },
  })
  console.log(`inbound calls ask ${publicUrl}/api/el/init who is calling`)
  for (const w of ours) if (w.webhook_id !== id) await root("DELETE", `/${w.webhook_id}`).catch(e => console.warn(`could not delete old webhook: ${e.message}`))
}

const secret = await secretId()
const agentId = await upsertAgent(await upsertTools(secret))
await setEnv("ELEVENLABS_AGENT_ID", agentId)
await agentWebhooks(agentId, secret)
const phone = env("ELEVENLABS_PHONE_NUMBER_ID")
if (phone) {
  await api("PATCH", `/phone-numbers/${phone}`, { agent_id: agentId })
  console.log(`phone number ${phone} now rings agent ${agentId}`)
}
console.log(`\nserver/.env has ELEVENLABS_AGENT_ID=${agentId}. Restart the server so it reads the new values.`)
