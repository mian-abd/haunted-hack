import { useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MOCK, post } from "./api"
import { CallPanel, useCall, type Call } from "./CallPanel"
import { CareFeed } from "./CareFeed"
import { useActor, type Conn } from "./live"
import { countdown, medBadge, type ElderState } from "./state"
import "./styles.css"

const STATUS_LABEL = { ok: "OK", watch: "Watch", urgent: "Urgent" }
const CONN_LABEL: Record<Conn, string> = { connecting: "Connecting", live: "Live", polling: "Polling", offline: "Server offline", mock: "Mock data" }
const WEB =
  "M120 0L-10 0M120 0L-0.1 49.7M120 0L28.1 91.9M120 0L70.3 120.1M120 0L120 130M92 0Q96.4 4.7 94.1 10.7Q100 13.4 100.2 19.8Q106.6 20 109.3 25.9Q115.3 23.6 120 28M68 0Q76.1 8.7 72 19.9Q82.8 24.8 83.2 36.8Q95.2 37.2 100.1 48Q111.3 43.9 120 52M42 0Q54.2 13.1 47.9 29.8Q64.2 37.3 64.8 55.2Q82.7 55.8 90.2 72.1Q106.9 65.8 120 78M16 0Q32.3 17.4 23.9 39.8Q45.6 49.7 46.5 73.5Q70.3 74.4 80.2 96.1Q102.6 87.7 120 104"

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
      <svg className="cobweb" viewBox="0 0 120 120" aria-hidden="true">
        <path d={WEB} />
      </svg>
      <div className="brand">
        <span className="logo">Unc</span>
        <span className="tagline">AI care team</span>
      </div>
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
                    {b === "taken" ? "✓ Taken" : b === "missed" ? `✕ Missed${m.missedCount > 1 ? ` ×${m.missedCount}` : ""}` : m.times.join(" · ")}
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
        <section className="elder-card elder-empty">No elder loaded yet. Open Demo and press Reset demo.</section>
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

createRoot(document.getElementById("root")!).render(<App />)
