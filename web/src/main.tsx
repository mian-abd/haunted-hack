import { useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MOCK, post } from "./api"
import { CallAction, HeardCard, Icon, TROSKA_LINE, clock, firstName, useCall, type Call } from "./CallPanel"
import { CareFeed } from "./CareFeed"
import { Landing } from "./landing/Landing"
import { DoctorPortal } from "./DoctorPortal"
import { useActor, type Conn } from "./live"
import { medBadge, type ElderState, type Med, type TimelineEvent } from "./state"
import "./styles.css"
import "./live.css"

const CONN: Record<Conn, string> = { connecting: "Connecting", live: "Live", polling: "Reconnecting", offline: "Offline", mock: "Sample data" }
const STATUS = { ok: (w: string) => `${w} is OK`, watch: (w: string) => `${w} needs attention`, urgent: (w: string) => `Urgent: call ${w} now` }
const STATUS_ICON = { ok: "good", watch: "warn", urgent: "bad" } as const

function useNow() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

function nextCall(s: ElderState, now: number): ReactNode {
  if (s.callState === "in_progress") return "A check-in call is happening now"
  if (s.callState === "due") return "A check-in call is due now"
  if (s.nextCheckInAt == null) return "No call scheduled yet"
  const sec = Math.ceil((s.nextCheckInAt - now) / 1000)
  if (sec <= 0) return "Next call starting now"
  const min = Math.ceil(sec / 60)
  const left = sec < 60 ? `${sec} sec` : min < 60 ? `${min} min` : `${Math.floor(min / 60)} hr${min % 60 ? ` ${min % 60} min` : ""}`
  return <>Next call at {clock(s.nextCheckInAt)} · <span className="lv-count">in {left}</span></>
}

/** The answer, above the fold: how Joe is, why, when Troska calls next, and the one big action. */
function StatusBand({ state, call, now }: { state: ElderState; call: Call; now: number }) {
  const p = state.profile
  const who = firstName(state)
  return (
    <section className={`lv-band is-${p ? state.status : "empty"}`} aria-labelledby="status-title">
      {p && (
        <figure className="lv-person">
          <img src="/press/lead-joe.webp" width={1536} height={1024} alt={`${p.name} at his kitchen table, talking on the phone`} />
          <figcaption>
            <span className="lv-name">{p.name}, {p.age}</span>
            <span className="lv-line1">Troska calls {who} every day</span>
          </figcaption>
        </figure>
      )}
      {p ? (
        <div className="lv-verdict" key={state.status}>
          <h1 id="status-title"><Icon name={STATUS_ICON[state.status]} className="icon lv-verdict-icon" />{STATUS[state.status](who)}</h1>
          <p className="lv-reason">{state.statusReason || "No concerns at the last check-in."}</p>
          <p className="lv-next"><Icon name="clock" />{nextCall(state, now)}</p>
        </div>
      ) : (
        <div className="lv-verdict">
          <h1 id="status-title">No one to show yet</h1>
          <p className="lv-reason">Once a parent is set up, how they are doing shows up here. For the demo, open Demo tools at the bottom of the page and press Reset demo.</p>
        </div>
      )}
      <CallAction state={state} call={call} now={now} />
    </section>
  )
}

const timeOfDay = (t: string) => new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const MED_ICON = { taken: "good", missed: "bad", due: "clock" } as const

function Medicines({ meds, now, who }: { meds: Med[]; now: number; who: string }) {
  const hhmm = new Date(now).toTimeString().slice(0, 5)
  return (
    <section className="lv-sec lv-meds" aria-labelledby="meds-title">
      <h2 id="meds-title">Medicines</h2>
      {meds.length === 0 ? (
        <p className="lv-empty">Once {who}'s medicines are set up, Troska asks about each one on every call and marks it taken or missed here. To set them up for the demo, open Demo tools below and press Reset demo.</p>
      ) : (
        <ul>
          {meds.map(m => {
            const b = medBadge(m, now)
            const next = m.times.find(t => t > hhmm) ?? m.times[0]
            const words = b === "taken" ? "Taken today" : b === "missed" ? (m.missedCount > 1 ? `Missed ${m.missedCount} times` : "Missed") : next ? `Due at ${timeOfDay(next)}` : "Not confirmed yet"
            return (
              <li key={m.name}>
                <div>
                  <p className="lv-med-name">{m.name} <span>{m.dose}</span></p>
                  <p className="lv-med-sub">For {m.purpose.split(",")[0]} · {m.times.map(timeOfDay).join(" and ")}</p>
                </div>
                <span className={`lv-chip is-${b}`}><Icon name={MED_ICON[b]} />{words}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const DAY = 86_400_000
function when(ts: number, now: number) {
  const d = (x: number) => new Date(x).setHours(0, 0, 0, 0)
  const days = Math.round((d(now) - d(ts)) / DAY)
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : new Date(ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
  return `${day} ${clock(ts)}`
}

/** "Troska remembers": every finished call, newest first, in one line each. */
function Remembers({ timeline, now, who }: { timeline: TimelineEvent[]; now: number; who: string }) {
  const calls = timeline.filter(e => e.kind === "call_ended").reverse()
  const line = (e: TimelineEvent) => {
    const mood = typeof e.data?.mood === "string" && e.data.mood !== "unknown" ? `felt ${e.data.mood}` : ""
    return [e.text.trim().replace(/\.$/, ""), mood].filter(Boolean).join(", ") || "A short call."
  }
  return (
    <section className="lv-sec lv-memory" aria-labelledby="memory-title">
      <h2 id="memory-title">Troska remembers</h2>
      {calls.length === 0 ? (
        <p className="lv-empty">Every call adds a line here, so you can see how {who} has been from one day to the next.</p>
      ) : (
        <ol className="lv-mem-list">
          {calls.map(e => (
            <li key={e.id}><time dateTime={new Date(e.ts).toISOString()}>{when(e.ts, now)}</time><span>{line(e)}.</span></li>
          ))}
        </ol>
      )}
    </section>
  )
}

function DemoTools({ call }: { call: Call }) {
  const [msg, setMsg] = useState(MOCK ? "Sample data: these buttons do nothing here." : "")
  const run = (label: string, path: string, body: Record<string, unknown> = {}) =>
    post(path, body).then(
      () => setMsg(`${label}: done.`),
      (err: Error) => setMsg(`${label} did not work: ${err.message}`),
    )
  return (
    <footer className="lv-foot">
      <details className="lv-tools">
        <summary>Demo tools</summary>
        <div className="lv-tools-body">
          <button className="btn btn-secondary btn-small" onClick={() => { call.clear(); void run("Reset demo", "/api/demo/reset") }}>Reset demo</button>
          <button className="btn btn-secondary btn-small" onClick={() => run("Next call in 1 minute", "/api/demo/schedule", { inSeconds: 60 })}>Schedule the next call in 1 minute</button>
          {msg && <p role="status">{msg}</p>}
        </div>
      </details>
      <p className="lv-fiction">Joe and his family are fictional demo characters.</p>
    </footer>
  )
}

function App() {
  const [state, conn] = useActor()
  const now = useNow()
  const call = useCall(state)
  return (
    <div className="lv">
      <header className="lv-top">
        <a className="lv-brand" href="/">Troska</a>
        <a className="lv-line" href={TROSKA_LINE.href}><Icon name="phone" />Troska's line: {TROSKA_LINE.label}</a>
        <a className="lv-line" href="/doctor">For doctors and families</a>
        <span className={`lv-conn is-${conn}`}><span className="lv-conn-dot" aria-hidden="true" />{CONN[conn]}</span>
      </header>
      <main className="lv-main">
        <StatusBand state={state} call={call} now={now} />
        <div className="lv-col">
          <HeardCard state={state} onCall={state.callState === "in_progress" || call.phase === "voice"} start={call.start} />
          <Remembers timeline={state.timeline} now={now} who={firstName(state)} />
          <Medicines meds={state.meds} now={now} who={firstName(state)} />
        </div>
        <div className="lv-col">
          <CareFeed timeline={state.timeline} familyName={state.profile?.family.name} relation={state.profile?.family.relation} />
        </div>
        <DemoTools call={call} />
      </main>
    </div>
  )
}

// No router library: "/live" is the demo dashboard, "/doctor" the doctor and family page, every other path the landing page (vercel.json rewrites all paths here).
const path = location.pathname.replace(/\/+$/, "")
if (path === "/live") document.title = "Troska · Care dashboard"
if (path === "/doctor") document.title = "Troska · For doctors and families"
createRoot(document.getElementById("root")!).render(path === "/live" ? <App /> : path === "/doctor" ? <DoctorPortal /> : <Landing />)
