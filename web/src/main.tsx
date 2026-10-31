import { useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MOCK, post } from "./api"
import { CallPanel, useCall, type Call } from "./CallPanel"
import { CareFeed } from "./CareFeed"
import { Landing } from "./landing/Landing"
import { useActor, type Conn } from "./live"
import { countdown, medBadge, type ElderState } from "./state"
import "./styles.css"

const STATUS_LABEL = { ok: "OK", watch: "Watch", urgent: "Urgent" }
const CONN_LABEL: Record<Conn, string> = { connecting: "Connecting", live: "Live", polling: "Polling", offline: "Server offline", mock: "Mock data" }

function useNow() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

function TopBar({ state, conn, now, children }: { state: ElderState; conn: Conn; now: number; children: ReactNode }) {
  const p = state.profile
  const next = state.callState === "due" ? "Ringing" : state.callState === "in_progress" ? "On a call" : countdown(state.nextCheckInAt, Date.now()) // not the 1 s tick: a stale tick could flash 0:16 for a 15 s check-in
  return (
    <header className="top">
      <a className="brand" href="/">
        <span className="logo">Troska</span>
        <span className="tagline">AI care team</span>
      </a>
      {p ? (
        <section className="elder-card" aria-label="Elder status">
          <div className="ident">
            <div className="avatar" aria-hidden="true">{p.name.split(" ").map(w => w[0]).join("").slice(0, 2)}</div>
            <div>
              <h1>{p.name}, {p.age}</h1>
              <p className="muted">{p.conditions.join(" · ")}</p>
            </div>
          </div>
          <div className="status">
            <span key={state.status} className={`pill pill-${state.status}`}>{STATUS_LABEL[state.status]}</span>
            <p>{state.statusReason || "No concerns right now"}</p>
          </div>
          <ul className="meds" aria-label="Medications">
            {state.meds.map(m => {
              const b = medBadge(m, now)
              return (
                <li key={m.name}>
                  <span className="med-name">{m.name}</span>
                  <span className={`badge badge-${b}`}>
                    {b === "taken" ? "Taken" : b === "missed" ? `Missed${m.missedCount > 1 ? ` ×${m.missedCount}` : ""}` : m.times.join(" · ")}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="next">
            <span>Next check-in</span>
            <strong>{next}</strong>
          </div>
        </section>
      ) : (
        <section className="elder-card elder-empty">No elder loaded yet. Open Demo controls and press Reset demo.</section>
      )}
      <div className="top-right">
        <span className={`conn conn-${conn}`}>{CONN_LABEL[conn]}</span>
        {children}
      </div>
    </header>
  )
}

function DemoControls({ call }: { call: Call }) {
  const [msg, setMsg] = useState(MOCK ? "Mock mode: buttons do not reach the server" : "")
  const run = (label: string, path: string, body: Record<string, unknown> = {}) =>
    post(path, body).then(
      () => setMsg(`${label}: done`),
      (err: Error) => setMsg(`${label} failed: ${err.message}`),
    )
  return (
    <details className="demo">
      <summary>Demo controls</summary>
      <div className="demo-body">
        <button onClick={() => { call.clear(); void run("Reset", "/api/demo/reset") }}>Reset demo</button>
        <button onClick={() => run("Check-in in 15 s", "/api/demo/schedule", { inSeconds: 15 })}>Check-in in 15 s</button>
        <button onClick={() => run("Vitals spike", "/api/demo/vitals", { heartRate: 128, note: "Simulated watch reading" })}>Simulate vitals spike</button>
        <button onClick={call.startScript} disabled={call.phase !== "idle"}>Run scripted demo</button>
        {msg && <p className="demo-msg" role="status">{msg}</p>}
      </div>
    </details>
  )
}

function App() {
  const [state, conn] = useActor()
  const now = useNow()
  const call = useCall(state)
  return (
    <div className="app">
      <TopBar state={state} conn={conn} now={now}>
        <DemoControls call={call} />
      </TopBar>
      <main className="split">
        <CallPanel state={state} call={call} now={now} />
        <CareFeed timeline={state.timeline} familyName={state.profile?.family.name} />
      </main>
    </div>
  )
}

// No router library: "/live" is the demo dashboard, every other path the landing page (vercel.json rewrites all paths here).
const live = location.pathname.replace(/\/+$/, "") === "/live"
if (live) document.title = "Troska · Live demo"
createRoot(document.getElementById("root")!).render(live ? <App /> : <Landing />)
