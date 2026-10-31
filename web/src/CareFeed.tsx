import { memo, useEffect, useRef } from "react"
import { LANES, agentThread, groupLanes, signals, tone, type TimelineEvent } from "./state"

const LANE_INFO = {
  doctor: { title: "Doctor", hint: "Triage packets" },
  pharmacy: { title: "Pharmacy", hint: "Refills" },
  family: { title: "Family", hint: "Updates for the family" },
}
const KIND_LABEL: Record<string, string> = { med: "Med", symptom: "Symptom", teach_back: "Teach-back", vitals: "Vitals", status: "Status" }
const AGENT_LABEL: Record<string, string> = { caretaker: "Caretaker", doctor: "Doctor", pharmacy: "Pharmacy", family: "Family agent", elder: "Elder", system: "System" }

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })

function Agent({ name, familyName }: { name?: string; familyName?: string }) {
  const label = name === "family-contact" ? (familyName ? `${familyName} (family)` : "Family contact") : AGENT_LABEL[name ?? ""] ?? name ?? "?"
  return <span className={`agent-name agent-${name ?? "unknown"}`}>{label}</span>
}

export const CareFeed = memo(function CareFeed({ timeline, familyName }: { timeline: TimelineEvent[]; familyName?: string }) {
  const lanes = groupLanes(timeline)
  const thread = agentThread(timeline)
  const chips = signals(timeline).slice(0, 12)
  const threadList = useRef<HTMLOListElement>(null)
  useEffect(() => {
    threadList.current?.scrollTo({ top: threadList.current.scrollHeight, behavior: "smooth" }) // block body: scrollTo returns a Promise in new Chrome
  }, [thread.length])

  return (
    <section className="panel feed" aria-label="Care Feed">
      <header className="panel-head">
        <h2>Care Feed</h2>
        <p className="muted">What the care team receives, as it happens</p>
      </header>

      <ul className="chips" aria-label="Signals from the call">
        {chips.length === 0 && <li className="chip chip-empty">Signals from the call appear here</li>}
        {chips.map(e => (
          <li key={e.id} className={`chip tone-${tone(e)} enter`}>
            <b>{KIND_LABEL[e.kind]}</b> {e.text}
          </li>
        ))}
      </ul>

      <div className="lanes">
        {LANES.map(lane => (
          <div key={lane} className={`lane lane-${lane}`}>
            <h3>
              {LANE_INFO[lane].title} <span className="count">{lanes[lane].length}</span>
            </h3>
            <ol aria-live="polite">
              {lanes[lane].length === 0 && <li className="empty">{LANE_INFO[lane].hint} will show up here</li>}
              {lanes[lane].map(e => (
                <li key={e.id} className="card enter">
                  <div className="card-meta">
                    <Agent name={e.from} familyName={familyName} /> → <Agent name={e.to} familyName={familyName} />
                    {e.data?.urgency && <span className={`mini-pill pill-${e.data.urgency}`}>{e.data.urgency}</span>}
                  </div>
                  <p>{e.text}</p>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      <div className="thread">
        <h3>
          Agent thread <span className="muted">· Agent Relay</span>
        </h3>
        <ol ref={threadList}>
          {thread.length === 0 && <li className="empty">The care team's messages to each other stream here</li>}
          {thread.map(e => (
            <li key={e.id} className={`msg agent-${e.from ?? "unknown"} enter`}>
              <div className="msg-route">
                <Agent name={e.from} familyName={familyName} /> → <Agent name={e.to} familyName={familyName} />
                <time>{clock(e.ts)}</time>
              </div>
              <p>{e.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
})
