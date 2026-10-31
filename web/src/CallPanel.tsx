import { useEffect, useRef, useState, type ReactNode } from "react"
import { ELDER, MOCK, getJSON, post } from "./api"
import { mmss, type ElderState, type TimelineEvent, type Tone } from "./state"
import { VoiceOffline, startMeter, startVoice } from "./voice"
import "./CallPanel.css"

export type Phase = "idle" | "dialing" | "connecting" | "voice"
export type Call = ReturnType<typeof useCall>
export type Heard = { id: string; text: string; detail?: string; tone: Tone }

/** Troska's own phone line (the Twilio number the ElevenLabs agent calls from). The elder's number is never shown. */
export const TROSKA_LINE = { href: "tel:+16812068273", label: "+1 (681) 206-8273" }

export const firstName = (s: ElderState) => s.profile?.name.split(" ")[0] ?? "Joe"
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const RECAP = "Call recap: "
const SEVERITY: Record<string, string> = { low: "mild", medium: "moderate", high: "serious" }

/** The latest call's events: everything since the last call_started (the whole timeline before any call). */
function lastCall(timeline: TimelineEvent[]) {
  const back = timeline.slice().reverse().findIndex(e => e.kind === "call_started")
  return back < 0 ? timeline : timeline.slice(timeline.length - 1 - back)
}

/** The latest call's recap: the phone's post-call note wins over the agent's own end_call summary. */
export function recap(timeline: TimelineEvent[]): TimelineEvent | undefined {
  const call = lastCall(timeline).slice().reverse()
  const note = call.find(e => e.kind === "note" && e.text.startsWith(RECAP))
  return note ? { ...note, text: note.text.slice(RECAP.length) } : call.find(e => e.kind === "call_ended")
}

/** "What Troska heard": one plain sentence per fact from the latest call, never the words spoken. */
export function heard(s: ElderState): Heard[] {
  const who = firstName(s)
  const rows: Heard[] = []
  for (const e of lastCall(s.timeline)) {
    const d = e.data ?? {}
    const med = str(d.med) ?? "a medicine"
    const purpose = s.meds.find(m => m.name === med)?.purpose.split(",")[0]
    const detail = str(d.note)
    if (e.kind === "med")
      rows.push(d.taken === true
        ? { id: e.id, text: `${who} took ${med}.`, detail, tone: "good" }
        : { id: e.id, text: `${who} has not taken ${med}${purpose ? `, for ${purpose}` : ""}.`, detail, tone: "bad" })
    else if (e.kind === "symptom") {
      const sev = SEVERITY[String(d.severity)]
      rows.push({ id: e.id, text: `${who} reported ${sev ? `a ${sev}` : "a"} symptom: ${e.text.charAt(0).toLowerCase()}${e.text.slice(1)}.`, tone: d.severity === "high" ? "bad" : d.severity === "medium" ? "warn" : "neutral" })
    } else if (e.kind === "teach_back")
      rows.push(d.understood === true
        ? { id: e.id, text: `${who} explained how to take ${med}, correctly.`, detail, tone: "good" }
        : { id: e.id, text: `${who} mixed up how to take ${med}, so Troska went over it again.`, detail, tone: "warn" })
  }
  const r = recap(s.timeline)
  if (r) rows.push({ id: r.id, text: `Troska's summary: ${r.text}`, tone: "neutral" })
  return rows
}

export function useCall(state: ElderState) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [notice, setNotice] = useState("")
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const session = useRef<{ close: () => void } | null>(null)
  const latest = useRef(state)
  latest.current = state
  // Phone mode (server/ has ElevenLabs + Twilio set up): the button rings the elder's real phone from Troska's line.
  // What the phone agent hears arrives through the actor timeline, like everything else.
  const [mode, setMode] = useState({ phone: false, autoDial: false })
  useEffect(() => {
    if (!MOCK) getJSON(`/api/call/mode?elderId=${ELDER}`).then(setMode).catch(() => {})
  }, [])
  // The server marks the call in progress once ElevenLabs places it; that ends "Calling…".
  useEffect(() => {
    if (state.callState === "in_progress") setPhase(p => (p === "dialing" ? "idle" : p))
  }, [state.callState])

  const onEnd = (agentEnded: boolean) => {
    session.current = null
    setPhase("idle")
    setStream(null)
    // The agent's end_call tool already ran endCall on the server; only an early hang-up needs reporting.
    if (!agentEnded) post("/api/call/end", { summary: "Call ended before the wrap-up.", mood: "unknown" }).catch(() => {})
  }

  async function startPhoneCall() {
    if (phase === "dialing") return
    setNotice("")
    setPhase("dialing")
    try {
      await post("/api/call/dial", {}) // post() sends the team access code, like every other request
      setTimeout(() => setPhase(p => (p === "dialing" ? "idle" : p)), 20_000) // shortcut: no live update within 20 s drops back to idle; fine while the socket or polling works
    } catch (err) {
      setPhase("idle")
      setNotice(`The call did not go through: ${(err as { body?: { error?: string } }).body?.error ?? (err as Error).message}`)
    }
  }

  async function startBrowserCall() {
    if (session.current || phase === "connecting") return
    setNotice("")
    setPhase("connecting")
    try {
      const s = await startVoice(latest.current, () => {}, onEnd) // what Troska hears reaches the screen through the timeline, as on the phone
      session.current = s
      setStream(s.mic)
      setStartedAt(Date.now())
      setPhase("voice")
      post("/api/call/start", {}).catch((err: Error) => setNotice(`The server did not record the start: ${err.message}`))
    } catch (err) {
      setPhase("idle")
      setNotice(err instanceof VoiceOffline ? "The browser check-in is not available right now." : `The browser check-in could not start (${(err as Error).message}).`)
    }
  }

  return {
    phase, notice, stream, startedAt, phone: mode.phone, autoDial: mode.autoDial,
    start: () => (mode.phone ? startPhoneCall() : startBrowserCall()),
    hangUp: () => session.current?.close(),
    clear: () => setNotice(""),
  }
}

const PATHS = {
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  good: "M20 6 9 17l-5-5",
  warn: "M12 8v5M12 16.5v.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  bad: "M12 8v5M12 16.5v.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  neutral: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  clock: "M12 7v5l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  chevron: "m6 9 6 6 6-6",
}
export const Icon = ({ name, className = "icon" }: { name: keyof typeof PATHS; className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d={PATHS[name]} />
  </svg>
)

const Bars = () => <span className="cp-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>

/** The call card inside the status band: one big action, or what the call is doing right now. */
export function CallAction({ state, call, now }: { state: ElderState; call: Call; now: number }) {
  const who = firstName(state)
  const meter = useRef<HTMLSpanElement>(null)
  useEffect(() => (call.stream && meter.current ? startMeter(call.stream, meter.current) : undefined), [call.stream])
  const last = recap(state.timeline)
  const startedAt = state.timeline.slice().reverse().find(e => e.kind === "call_started")?.ts
  // The phone is the real call. With phone calls off, the browser check-in stays only as a quiet fallback link.
  const callNow = (
    <button className="btn btn-primary cp-call" onClick={call.start} disabled={!call.phone}>
      <Icon name="phone" /> Call {who} now
    </button>
  )
  const note = call.phone
    ? <p className="cp-note">Rings {who}'s phone from Troska's line, {TROSKA_LINE.label}.</p>
    : <p className="cp-note">Phone calls are off right now. <button className="cp-link" onClick={call.start}>Check in here with this computer's microphone instead</button></p>

  let title: string, visual: ReactNode = null, body: ReactNode = null, action: ReactNode = <>{callNow}{note}</>, live = false
  if (call.phase === "voice") {
    title = `Checking in with ${who} here`
    live = true
    visual = <p className="cp-talk"><Bars /><span className="cp-timer">{mmss(now - call.startedAt)}</span><span ref={meter} className="cp-meter" role="img" aria-label="Microphone level"><span /></span></p>
    action = <button className="btn btn-secondary" onClick={call.hangUp}>End the check-in</button>
  } else if (call.phase === "connecting") {
    title = "Starting the check-in…"
    body = <p className="cp-body">Allow the microphone if your browser asks.</p>
    action = null
  } else if (state.callState === "in_progress") {
    title = call.phone ? `On the phone with ${who}` : `${who}'s check\u2011in is in progress`
    live = true
    visual = <p className="cp-talk"><Bars />{startedAt != null && <span className="cp-timer">{mmss(now - startedAt)}</span>}</p>
    body = <p className="cp-body">Troska is talking with {who}. What Troska hears shows up below as the call goes on.</p>
    action = null
  } else if (call.phase === "dialing" || (state.callState === "due" && call.phone && call.autoDial)) {
    title = `Calling ${who}'s phone…`
    visual = <span className="cp-ring" aria-hidden="true"><Icon name="phone" /></span>
    body = <p className="cp-body">Ringing from Troska's line. This page updates on its own when {who} answers.</p>
    action = null
  } else if (state.callState === "due") {
    title = `Time for ${who}'s check-in`
    body = <p className="cp-body">The next call is due now.</p>
  } else if (last) {
    title = `Call ended at ${clock(last.ts)}`
    body = <p className="cp-body cp-recap">{last.text}</p>
  } else {
    title = `Troska hasn't called ${who} yet today`
    body = <p className="cp-body">{state.nextCheckInAt ? `The next call is at ${clock(state.nextCheckInAt)}, or call now.` : `Call now, or wait for the daily call.`}</p>
  }

  return (
    <section className={`cp-action${live ? " is-live" : ""}`} aria-labelledby="cp-title">
      <h2 id="cp-title" className="cp-title" aria-live="polite">
        {live && <span className="cp-live"><span className="cp-dot" aria-hidden="true" />Live</span>}
        {title}
      </h2>
      {visual}
      {body}
      {action && <div className="cp-actions">{action}</div>}
      {call.notice && <p className="cp-notice" role="alert">{call.notice}</p>}
    </section>
  )
}

/** "What Troska heard": newest first, each fact slides in as it arrives. */
export function HeardCard({ state, onCall, start }: { state: ElderState; onCall: boolean; start: () => void }) {
  const who = firstName(state)
  const last = recap(state.timeline)
  const rows = heard(state).reverse()
  return (
    <section className="lv-sec cp-heard" aria-labelledby="heard-title">
      <h2 id="heard-title">What Troska heard</h2>
      <p className="cp-sub">
        {onCall ? "From the call happening now. " : last ? `From the call at ${clock(last.ts)}. ` : ""}
        Only what Troska learned, never a word-for-word record.
      </p>
      {rows.length === 0 ? (
        <div className="lv-empty cp-empty">
          <svg viewBox="0 0 64 64" aria-hidden="true" className="cp-empty-art" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 10h8l4 10-5 3a24 24 0 0 0 12 12l3-5 10 4v8a4 4 0 0 1-4 4C25 46 10 31 10 14a4 4 0 0 1 4-4z" />
            <path d="M38 8a18 18 0 0 1 18 18M38 16a10 10 0 0 1 10 10" className="cp-waves" />
          </svg>
          <p>After each call, what {who} says shows up here in plain words: which medicines he took, how he feels, and whether the instructions made sense. <button className="cp-link" onClick={start}>Call {who} now</button></p>
        </div>
      ) : (
        <ul className="cp-list" aria-live="polite">
          {rows.map(h => (
            <li key={h.id} className={`cp-row tone-${h.tone}`}>
              <Icon name={h.tone} className="icon cp-row-icon" />
              <div>
                <p>{h.text}</p>
                {h.detail && <p className="cp-detail">{h.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
