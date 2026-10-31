import { useEffect, useRef, useState } from "react"
import { ELDER, MOCK, SERVER, getJSON, post } from "./api"
import { runScript, storyline } from "./script"
import { mmss, type ElderState, type Tone } from "./state"
import { VoiceOffline, applyVoiceEvent, functionCalls, startMeter, startVoice, type Line } from "./voice"

export type Phase = "idle" | "connecting" | "voice" | "script"
export type Call = ReturnType<typeof useCall>
type Args = Record<string, unknown>
export type Heard = { id: string; kind: "med" | "symptom" | "refill" | "teach_back" | "summary"; text: string; detail?: string; tone: Tone }

const OFFLINE = "Voice offline — use Run scripted demo"
const KIND_LABEL: Record<Heard["kind"], string> = { med: "Medication", symptom: "Symptom", refill: "Refill request", teach_back: "Teach-back", summary: "Summary" }

/** One "What Unc heard" row per tool call: the facts the agent extracted, never the words. */
export function heard(id: string, name: string, a: Args): Heard | null {
  const s = (v: unknown) => (v == null ? "" : String(v).trim())
  const note = s(a.note) || undefined
  switch (name) {
    case "confirm_medication":
      return { id, kind: "med", text: `${s(a.med)} ${a.taken === true ? "taken" : "missed"}`, detail: note, tone: a.taken === true ? "good" : "bad" }
    case "report_symptom": {
      const sev = s(a.severity)
      return { id, kind: "symptom", text: s(a.symptom), detail: sev ? `${sev} severity` : undefined, tone: sev === "high" ? "bad" : sev === "medium" ? "warn" : "neutral" }
    }
    case "request_refill":
      return { id, kind: "refill", text: s(a.med), tone: "neutral" }
    case "teach_back_result":
      return { id, kind: "teach_back", text: `${s(a.med)}: ${a.understood === true ? "explained it right" : "mixed up, then corrected"}`, detail: note, tone: a.understood === true ? "good" : "warn" }
    case "end_call":
      return { id, kind: "summary", text: s(a.summary), detail: s(a.mood) ? `Mood: ${s(a.mood)}` : undefined, tone: "neutral" }
  }
  return null
}

export function useCall(state: ElderState) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<Line[]>([])
  const [notice, setNotice] = useState("")
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [model, setModel] = useState("")
  const [startedAt, setStartedAt] = useState(0)
  const session = useRef<{ close: () => void } | null>(null)
  const tools = useRef(new Map<string, [name: string, args: Args]>()) // tool line id → structured call: a Line only carries a display label
  const latest = useRef(state)
  latest.current = state
  // Phone mode (server/ has ElevenLabs + Twilio set up): "Start check-in" rings the elder's real phone instead of
  // opening the browser call. What the phone agent hears arrives through the actor timeline, like everything else.
  const [phone, setPhone] = useState({ phone: false, autoDial: false })
  useEffect(() => {
    if (!MOCK) getJSON(`/api/call/mode?elderId=${ELDER}`).then(setPhone).catch(() => {})
  }, [])

  const begin = (p: Phase) => {
    setNotice("")
    setLines([])
    tools.current.clear()
    setStartedAt(Date.now())
    setPhase(p)
  }
  const onEnd = (agentEnded: boolean) => {
    session.current = null
    setPhase("idle")
    setStream(null)
    // The agent's end_call tool already ran endCall on the server; only an early hang-up needs reporting.
    if (!agentEnded) post("/api/call/end", { summary: "Call ended before the wrap-up.", mood: "unknown" }).catch(() => {})
  }

  async function startPhoneCall() {
    const first = latest.current.profile?.name.split(" ")[0] ?? "Joe"
    setNotice("")
    try {
      const r = await fetch(`${SERVER}/api/call/dial`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ elderId: ELDER }) })
      const out = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(out.error ?? `dial returned ${r.status}`)
      setNotice(`Calling ${first}'s phone…`)
    } catch (err) {
      setNotice(`Phone call failed: ${(err as Error).message}`)
    }
  }

  async function startVoiceCall() {
    if (phone.phone) return startPhoneCall()
    if (session.current || phase === "connecting") return
    begin("connecting")
    try {
      const s = await startVoice(latest.current, e => {
        for (const c of functionCalls(e)) tools.current.set(c.call_id, [c.name, c.args]) // applyVoiceEvent ids tool lines by call_id
        setLines(ls => applyVoiceEvent(ls, e))
      }, onEnd)
      session.current = s
      setStream(s.mic)
      setModel(s.model)
      setStartedAt(Date.now())
      setPhase("voice")
      post("/api/call/start", {}).catch((err: Error) => setNotice(`Server: ${err.message}`))
    } catch (err) {
      setPhase("idle")
      setNotice(err instanceof VoiceOffline ? OFFLINE : `Voice failed (${(err as Error).message}) — use Run scripted demo`)
    }
  }

  function startScript() {
    if (session.current || phase === "connecting") return
    begin("script")
    for (const [i, step] of storyline(latest.current).entries()) if ("tool" in step) tools.current.set(`script-${i}`, step.tool) // runScript ids tool lines script-<step index>
    session.current = runScript(latest.current, setLines, onEnd)
  }

  const hangUp = () => session.current?.close()
  const clear = () => {
    if (session.current) return
    setLines([])
    setNotice("")
  }
  const facts = lines.flatMap(l => {
    const t = l.who === "tool" ? tools.current.get(l.id) : undefined
    const h = t && heard(l.id, ...t)
    return h ? [h] : []
  })
  return { phase, lines, heard: facts, notice, stream, model, startedAt, startVoiceCall, startScript, hangUp, clear, phone: phone.phone, autoDial: phone.autoDial }
}

const PHONE = "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
const PhoneIcon = ({ down = false }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={down ? "icon icon-down" : "icon"}>
    <path d={PHONE} fill="currentColor" />
  </svg>
)

export function CallPanel({ state, call, now }: { state: ElderState; call: Call; now: number }) {
  const first = state.profile?.name.split(" ")[0] ?? "Joe"
  const inCall = call.phase === "voice" || call.phase === "script"
  const last = call.lines.at(-1)
  const showHeard = inCall || call.heard.length > 0
  const meter = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => (call.stream && meter.current ? startMeter(call.stream, meter.current) : undefined), [call.stream])
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: inCall ? "smooth" : "auto" }) // block body: scrollTo returns a Promise in new Chrome
  }, [call.heard.length, inCall])

  let stage
  if (inCall) {
    stage = (
      <div className="oncall">
        <div>
          <p className="oncall-title">On call with {first}</p>
          <p className="muted">
            <span className="timer">{mmss(now - call.startedAt)}</span> · {call.phase === "voice" ? `Live voice · ${call.model || "OpenAI Realtime"}` : "Scripted demo"}
          </p>
        </div>
        <div
          ref={meter}
          className={`meter${call.phase === "script" && last?.who === "elder" && !last.final ? " sim" : ""}`}
          role="img"
          aria-label="Microphone level"
        >
          <span />
        </div>
        <button className="btn btn-hang" onClick={call.hangUp}>
          <PhoneIcon down /> Hang up
        </button>
      </div>
    )
  } else if (call.phase === "connecting") {
    stage = (
      <div className="stage">
        <div className="ring ring-wait"><PhoneIcon /></div>
        <p className="stage-title">Connecting the voice agent…</p>
      </div>
    )
  } else if (state.callState === "due") {
    stage = (
      <div className="stage">
        <div className="ring"><PhoneIcon /></div>
        <p className="stage-title">{call.phone ? `Check-in due: ${call.autoDial ? "calling" : "call"} Grandpa ${first}'s phone` : `Incoming check-in call for Grandpa ${first}`}</p>
        <button className="btn btn-answer" onClick={call.startVoiceCall}>
          <PhoneIcon /> {call.phone ? "Call now" : "Answer"}
        </button>
      </div>
    )
  } else if (call.phone && state.callState === "in_progress") {
    stage = (
      <div className="stage">
        <div className="ring ring-wait"><PhoneIcon /></div>
        <p className="stage-title">On the phone with {first}</p>
        <p className="muted">Unc is talking to {first} on his phone. What he says reaches the care team as the agent hears it.</p>
      </div>
    )
  } else {
    stage = (
      <div className="stage">
        <p className="stage-title">{state.callState === "in_progress" ? "A check-in call is in progress" : `Ready when ${first} is`}</p>
        <p className="muted">
          Unc calls to check meds, run a teach-back and hear how {first} feels.{call.phone ? ` This rings ${first}'s real phone.` : ""}
        </p>
        <button className="btn btn-primary" onClick={call.startVoiceCall}>{call.phone ? `Call ${first}'s phone` : "Start check-in"}</button>
      </div>
    )
  }

  return (
    <section className={`panel call${showHeard ? " has-heard" : ""}`} aria-label="Check-in call">
      <header className="panel-head">
        <h2>Check-in call</h2>
        {inCall && <span className="live-tag">Live</span>}
      </header>
      {call.notice && <p className="notice" role="alert">{call.notice}</p>}
      {stage}
      {showHeard && (
        <section className="heard" aria-label="What Unc heard">
          <div className="heard-head">
            <h3 className="sub">{inCall ? "What Unc heard" : "Last call: what Unc heard"}</h3>
            <span className="muted">Summaries only, no transcript</span>
          </div>
          <ol ref={list} className="heard-list" aria-live="polite">
            {call.heard.length === 0 && <li className="empty">Meds, symptoms and teach-back results appear here as Unc hears them</li>}
            {call.heard.map(h => (
              <li key={h.id} className={`heard-item heard-${h.kind} tone-${h.tone} enter`}>
                <span className="heard-kind">{KIND_LABEL[h.kind]}</span>
                <span className="heard-text">{h.text}</span>
                {h.detail && <span className="heard-detail">{h.detail}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  )
}
