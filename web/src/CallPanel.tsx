import { useEffect, useRef, useState } from "react"
import { post } from "./api"
import { runScript } from "./script"
import { mmss, type ElderState } from "./state"
import { VoiceOffline, applyVoiceEvent, startMeter, startVoice, type Line } from "./voice"

export type Phase = "idle" | "connecting" | "voice" | "script"
export type Call = ReturnType<typeof useCall>

const OFFLINE = "Voice offline — use Run scripted demo"

export function useCall(state: ElderState) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<Line[]>([])
  const [notice, setNotice] = useState("")
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [model, setModel] = useState("")
  const [startedAt, setStartedAt] = useState(0)
  const session = useRef<{ close: () => void } | null>(null)
  const latest = useRef(state)
  latest.current = state

  const begin = (p: Phase) => {
    setNotice("")
    setLines([])
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

  async function startVoiceCall() {
    if (session.current || phase === "connecting") return
    begin("connecting")
    try {
      const s = await startVoice(latest.current, e => setLines(ls => applyVoiceEvent(ls, e)), onEnd)
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
    session.current = runScript(latest.current, setLines, onEnd)
  }

  const hangUp = () => session.current?.close()
  const clear = () => {
    if (session.current) return
    setLines([])
    setNotice("")
  }
  return { phase, lines, notice, stream, model, startedAt, startVoiceCall, startScript, hangUp, clear }
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
  const meter = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => (call.stream && meter.current ? startMeter(call.stream, meter.current) : undefined), [call.stream])
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: inCall ? "smooth" : "auto" }) // block body: scrollTo returns a Promise in new Chrome
  }, [call.lines, inCall]) // inCall: the list shrinks when the call ends, keep its last line in view

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
        <p className="stage-title">Incoming check-in call for Grandpa {first}</p>
        <button className="btn btn-answer" onClick={call.startVoiceCall}>
          <PhoneIcon /> Answer
        </button>
      </div>
    )
  } else {
    stage = (
      <div className="stage">
        <p className="stage-title">{state.callState === "in_progress" ? "A check-in call is in progress" : `Ready when ${first} is`}</p>
        <p className="muted">Unc calls to check meds, run a teach-back and hear how {first} feels.</p>
        <button className="btn btn-primary" onClick={call.startVoiceCall}>Start check-in</button>
      </div>
    )
  }

  return (
    <section className={`panel call${call.lines.length ? " has-lines" : ""}`} aria-label="Check-in call">
      <header className="panel-head">
        <h2>Check-in call</h2>
        {inCall && <span className="live-tag">Live</span>}
      </header>
      {call.notice && <p className="notice" role="alert">{call.notice}</p>}
      {stage}
      {call.lines.length > 0 && (
        <>
          {!inCall && <h3 className="sub">Last call</h3>}
          <ol ref={list} className={`transcript${inCall ? "" : " dim"}`} aria-live="polite">
            {call.lines.map(l => (
              <li key={l.id} className={`line ${l.who}${l.final ? "" : " typing"}`}>
                <span className="who">{l.who === "agent" ? "Unc" : l.who === "elder" ? first : "Tool call"}</span>
                {l.text || "…"}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
