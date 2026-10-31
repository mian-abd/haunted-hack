// Voice agent: OpenAI Realtime (GA) over WebRTC with the 5 PLAN.md tools, executed by server/ via POST /api/tool.
// Verified against developers.openai.com/api/docs/guides/voice-webrtc (ephemeral-key flow) and the realtime
// client/server event references: SDP goes to /v1/realtime/calls as application/sdp, events use the "oai-events" channel.
import { MOCK, SERVER, post } from "./api"
import type { ElderState } from "./state"

export type Who = "elder" | "agent" | "tool"
export type Line = { id: string; who: Who; text: string; final: boolean }
export type ServerEvent = { type: string; [k: string]: any }
type Json = Record<string, unknown>

const str = (description: string) => ({ type: "string", description })
const fn = (name: string, description: string, properties: Json, required: string[]) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required },
})

export const TOOLS = [
  fn("confirm_medication", "Record whether the elder took one of their medicines today. Call once per medicine.",
    { med: str("Medicine name as listed"), taken: { type: "boolean" }, note: str("Anything they said about it, e.g. ran out") }, ["med", "taken"]),
  fn("report_symptom", "Log a symptom the elder mentions. Use severity high for danger signs.",
    { symptom: str("The symptom, in their words"), severity: { type: "string", enum: ["low", "medium", "high"] } }, ["symptom", "severity"]),
  fn("teach_back_result", "Record whether the elder explained correctly, in their own words, when and how they take a medicine.",
    { med: str("Medicine name"), understood: { type: "boolean" }, note: str("What they got wrong and the correction") }, ["med", "understood"]),
  fn("request_refill", "Ask the pharmacy to refill a medicine the elder is out of or low on.", { med: str("Medicine name") }, ["med"]),
  fn("end_call", "Finish the check-in, after the closing summary.",
    { summary: str("2-3 sentences for the family and the doctor"), mood: str("Their mood, in a few words") }, ["summary", "mood"]),
]

export function buildInstructions(s: ElderState): string {
  const p = s.profile
  const first = p?.name.split(" ")[0] ?? "there"
  const teach = s.meds.find(m => m.times.length > 1) ?? s.meds[0]
  const meds = s.meds.map(m =>
    `- ${m.name} ${m.dose} at ${m.times.join(" and ")}, for ${m.purpose}${m.missedCount ? ` (missed ${m.missedCount} time(s) recently)` : ""}`)
  return [
    `You are Unc, a warm care companion on a scheduled check-in call with ${p ? `${p.name}, age ${p.age}` : "an older adult"}. Call them ${first}.`,
    p && `Conditions: ${p.conditions.join(", ")}. Family contact: ${p.family.name} (${p.family.relation}).`,
    `Current status: ${s.status}${s.statusReason ? `, because: ${s.statusReason}` : ""}.`,
    `Style: be warm and speak slowly. Use short sentences. Ask one question at a time, then wait for the answer. Start by greeting ${first} by name and asking how they feel today.`,
    meds.length && `Medicines due today:\n${meds.join("\n")}\nGo through each medicine in turn. Confirm whether they took it, and call confirm_medication for each one.`,
    teach && `Teach-back: ask ${first} to explain in their own words when and how they take ${teach.name}. If they get it wrong, gently correct them and have them say it back. Then call teach_back_result (understood = whether they had it right the first time).`,
    "When they mention any symptom, call report_symptom. If they are out of a medicine or running low, offer a refill and call request_refill.",
    "To finish: give a short summary of what you heard and what happens next, then call end_call.",
    "Safety: never diagnose and never change doses. For urgent danger signs (chest pain, trouble breathing, fainting, slurred speech, weakness on one side, a bad fall), tell them to call 911 right now and call report_symptom with severity high.",
  ].filter(Boolean).join("\n\n")
}

export const sessionUpdate = (s: ElderState) => ({
  type: "session.update",
  session: {
    type: "realtime",
    instructions: buildInstructions(s),
    tools: TOOLS,
    tool_choice: "auto",
    audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
  },
})

export type FnCall = { call_id: string; name: string; args: Json }

/** Complete calls from response.done: the one event that has name, call_id and full arguments for the whole response. */
export function functionCalls(e: ServerEvent): FnCall[] {
  if (e.type !== "response.done") return []
  return (e.response?.output ?? []).flatMap((item: any) => {
    if (item.type !== "function_call") return []
    try {
      return [{ call_id: item.call_id, name: item.name, args: JSON.parse(item.arguments || "{}") }]
    } catch {
      return [] // arguments cut off by an interrupted response
    }
  })
}

export const toolLabel = (name: string, args: Json) =>
  [name, ...Object.entries(args).map(([k, v]) => (typeof v === "boolean" ? (v ? k : `not ${k}`) : String(v)))].join(" · ")

/** Transcript reducer: one bubble per conversation item, filled by deltas, plus a row per tool call. */
export function applyVoiceEvent(lines: Line[], e: ServerEvent): Line[] {
  switch (e.type) {
    case "input_audio_buffer.speech_started": // placeholder, so the elder's turn sits above the agent's reply
      return upsert(lines, e.item_id, "elder", l => l)
    case "conversation.item.input_audio_transcription.delta":
      return upsert(lines, e.item_id, "elder", l => ({ ...l, text: l.text + e.delta }))
    case "conversation.item.input_audio_transcription.completed": {
      const text = String(e.transcript ?? "").trim()
      return text ? upsert(lines, e.item_id, "elder", l => ({ ...l, text, final: true })) : lines.filter(l => l.id !== e.item_id)
    }
    case "conversation.item.input_audio_transcription.failed":
      return upsert(lines, e.item_id, "elder", l => ({ ...l, text: "(could not transcribe)", final: true }))
    case "response.output_audio_transcript.delta":
      return upsert(lines, e.item_id, "agent", l => ({ ...l, text: l.text + e.delta }))
    case "response.output_audio_transcript.done":
      return upsert(lines, e.item_id, "agent", l => ({ ...l, text: e.transcript ?? l.text, final: true }))
    case "response.done": {
      const calls = functionCalls(e)
      return calls.length ? [...lines, ...calls.map(c => ({ id: c.call_id, who: "tool" as const, text: toolLabel(c.name, c.args), final: true }))] : lines
    }
    default:
      return lines
  }
}

function upsert(lines: Line[], id: string, who: Who, f: (l: Line) => Line): Line[] {
  const i = lines.findIndex(l => l.id === id)
  return i < 0 ? [...lines, f({ id, who, text: "", final: false })] : lines.map((l, j) => (j === i ? f(l) : l))
}

export class VoiceOffline extends Error {}
export type VoiceSession = { close: () => void; mic: MediaStream; model: string }

const CALLS_URL = "https://api.openai.com/v1/realtime/calls" // GA endpoint; the model is bound to the ephemeral session
// ?debug in the page URL logs connection states and every Realtime server event type (the headless voice smoke test reads these).
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debug")
const debug = (...a: unknown[]) => DEBUG && console.info("[realtime]", ...a)

/** Connects a live call. onEnd fires once, with agentEnded = true when the agent's end_call already closed the call. */
export async function startVoice(state: ElderState, onEvent: (e: ServerEvent) => void, onEnd: (agentEnded: boolean) => void): Promise<VoiceSession> {
  if (MOCK) throw new VoiceOffline("mock mode")
  const tok = await fetch(`${SERVER}/api/realtime-token`)
  if (tok.status === 503) throw new VoiceOffline("no OpenAI key on the server")
  if (!tok.ok) throw new Error(`realtime-token returned ${tok.status}`)
  const { value, model } = await tok.json()

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  const pc = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  pc.ontrack = e => (audio.srcObject = e.streams[0])
  pc.addTrack(mic.getAudioTracks()[0], mic)
  const dc = pc.createDataChannel("oai-events")
  const send = (msg: object) => dc.readyState === "open" && dc.send(JSON.stringify(msg))

  let closed = false
  let agentEnded = false
  let endAfter = "" // id of the response that called end_call: hang up when the goodbye after it finishes playing
  let endTimer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(endTimer)
    mic.getTracks().forEach(t => t.stop())
    dc.close()
    pc.close()
    audio.srcObject = null
    onEnd(agentEnded)
  }

  dc.onopen = () => {
    debug("datachannel open:", dc.label)
    send(sessionUpdate(state))
    send({ type: "response.create" }) // the agent speaks first, like a real call
  }
  dc.onclose = close
  pc.onconnectionstatechange = () => {
    debug("peer connection:", pc.connectionState)
    if (pc.connectionState === "failed") close()
  }
  dc.onmessage = async ev => {
    const e: ServerEvent = JSON.parse(ev.data)
    debug("event:", e.type, e.type === "error" ? JSON.stringify(e.error) : "")
    onEvent(e)
    if (e.type === "error") console.warn("[realtime]", e.error)
    if (e.type === "output_audio_buffer.stopped" && endAfter && e.response_id !== endAfter) close()
    const calls = functionCalls(e)
    if (!calls.length) return
    for (const c of calls) {
      const res = await post("/api/tool", { name: c.name, args: c.args }).catch((err: Error) => ({ output: `Tool failed: ${err.message}` }))
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: String(res?.output ?? "ok") } })
      if (c.name === "end_call") {
        agentEnded = true
        endAfter = e.response.id
        endTimer = setTimeout(close, 12_000) // in case the goodbye has no audio
      }
    }
    send({ type: "response.create" })
  }

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const r = await fetch(CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${value}`, "Content-Type": "application/sdp" },
    })
    if (!r.ok) throw new Error(`OpenAI returned ${r.status}`)
    await pc.setRemoteDescription({ type: "answer", sdp: await r.text() })
  } catch (err) {
    closed = true // never connected: free the mic without reporting a call end
    mic.getTracks().forEach(t => t.stop())
    pc.close()
    throw err
  }
  return { close, mic, model: String(model ?? "") }
}

/** Writes the mic level (0..1) to the --level CSS variable of el every frame. Returns a stop function. */
export function startMeter(stream: MediaStream, el: HTMLElement): () => void {
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  let raf = 0
  const tick = () => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    el.style.setProperty("--level", Math.min(1, Math.sqrt(sum / buf.length) * 5).toFixed(3))
    raf = requestAnimationFrame(tick)
  }
  tick()
  return () => {
    cancelAnimationFrame(raf)
    void ctx.close()
  }
}
