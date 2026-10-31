import { useEffect, useState } from "react"
import { getJSON } from "../api"
import { Icon } from "../CallPanel"
import "./History.css"

export type Call = { started_at: string | null; ended_at: string | null; summary: string | null; mood: string | null }
export type Ev = { created_at: string; kind: string; from_agent: string | null; to_agent: string | null; text: string }
type Item = { t: number; call?: Call; events: Ev[] }

const NEAR = 15 * 60_000 // an event up to 15 min after a call still belongs to that call
const PAGE = 20
const WHO: Record<string, string> = { caretaker: "Troska", doctor: "Doctor", pharmacy: "Pharmacy", family: "Family", "family-contact": "Family contact" }
const KIND: Record<string, { label: string; icon: Parameters<typeof Icon>[0]["name"] }> = {
  med: { label: "Medicine", icon: "good" },
  symptom: { label: "Symptom", icon: "warn" },
  teach_back: { label: "Checked he understood", icon: "good" },
  vitals: { label: "Vitals", icon: "clock" },
  agent_msg: { label: "Message", icon: "neutral" },
  call_ended: { label: "Call ended", icon: "phone" },
  status: { label: "Update", icon: "neutral" },
  note: { label: "Note", icon: "neutral" },
}
const FILTERS = [["all", "All"], ["calls", "Calls"], ["med", "Medicines"], ["symptom", "Symptoms"], ["agent_msg", "Messages"]] as const
export type Filter = (typeof FILTERS)[number][0]

const ms = (s: string | null) => (s ? Date.parse(s) : NaN)
const who = (a: string | null) => (a ? WHO[a] ?? a : "Troska")
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? s
function day(t: number): string {
  if (isNaN(t)) return "Date unknown"
  const d = new Date(t), now = new Date(), y = new Date(now.getTime() - 86_400_000)
  if (d.toDateString() === now.toDateString()) return "Today"
  if (d.toDateString() === y.toDateString()) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })
}

/** Newest first. "all" nests each event under the call it happened in (or just after); the other filters are flat lists. */
export function timeline(calls: Call[], events: Ev[], filter: Filter): Item[] {
  const callItems = (): Item[] => calls.map(c => ({ t: ms(c.started_at ?? c.ended_at), call: c, events: [] }))
  if (filter === "calls") return callItems()
  if (filter !== "all") {
    return events.filter(e => e.kind === filter || (filter === "med" && e.kind === "teach_back")).map(e => ({ t: ms(e.created_at), events: [e] }))
  }
  const items = callItems()
  for (const e of events) {
    const t = ms(e.created_at)
    const home = items.find(i => i.call && t >= i.t && t <= ms(i.call.ended_at ?? i.call.started_at) + NEAR)
    if (home) home.events.push(e)
    else items.push({ t, events: [e] })
  }
  return items.sort((a, b) => (b.t || 0) - (a.t || 0))
}

export function History({ elderId }: { elderId: string }) {
  const [data, setData] = useState<{ calls: Call[]; events: Ev[] } | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  const [filter, setFilter] = useState<Filter>("all")
  const [shown, setShown] = useState(PAGE)

  const load = () => {
    setBusy(true)
    setError("")
    getJSON(`/api/history?elderId=${encodeURIComponent(elderId)}`)
      .then(d => setData({ calls: d?.calls ?? [], events: d?.events ?? [] }))
      .catch(() => setError("We could not load the history just now. Press Refresh to try again."))
      .finally(() => setBusy(false))
  }
  useEffect(load, [elderId])

  const items = data ? timeline(data.calls, data.events, filter) : []
  const groups: { day: string; items: Item[] }[] = []
  for (const i of items.slice(0, shown)) {
    const d = day(i.t)
    if (groups[groups.length - 1]?.day !== d) groups.push({ day: d, items: [] })
    groups[groups.length - 1].items.push(i)
  }

  return (
    <section className="hx" aria-labelledby="hx-title">
      <header className="hx-head">
        <h2 id="hx-title">History</h2>
        <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <div className="hx-filters" role="group" aria-label="Show in history">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="hx-filter" aria-pressed={filter === id} onClick={() => { setFilter(id); setShown(PAGE) }}>
            {label}
          </button>
        ))}
      </div>
      {error && <p className="hx-error" role="alert">{error}</p>}
      {!data ? (
        busy && (
          <div className="hx-skeleton" role="status">
            <span className="sr-only">Loading history…</span>
            {[0, 1, 2].map(n => <div key={n} aria-hidden="true"><i /><i /></div>)}
          </div>
        )
      ) : items.length === 0 ? (
        <p className="hx-empty">
          {data.calls.length + data.events.length === 0
            ? "No calls yet. After Troska's first call, every call and update will be listed here."
            : "Nothing of this kind yet."}
        </p>
      ) : (
        <>
          {groups.map(g => (
            <section key={g.day} className="hx-day" aria-label={g.day}>
              <h3>{g.day}</h3>
              <ol className="hx-list">
                {g.items.map((i, n) => (
                  <li key={n} className="hx-item">{i.call ? <CallRow call={i.call} events={i.events} /> : <EventLine e={i.events[0]} />}</li>
                ))}
              </ol>
            </section>
          ))}
          {items.length > shown && (
            <button type="button" className="btn btn-secondary btn-small hx-more" onClick={() => setShown(s => s + PAGE)}>
              Load more
            </button>
          )}
        </>
      )}
    </section>
  )
}

function CallRow({ call, events }: { call: Call; events: Ev[] }) {
  const start = ms(call.started_at), end = ms(call.ended_at)
  const t = isNaN(start) ? end : start
  const mins = isNaN(start) || isNaN(end) ? null : Math.max(1, Math.round((end - start) / 60_000))
  return (
    <article className="hx-call">
      <p className="hx-call-meta">
        <Icon name="phone" className="icon hx-icon" />
        <span className="hx-call-title">Call{isNaN(t) ? "" : ` at ${clock(t)}`}</span>
        {mins !== null && <span>{mins} min</span>}
        {call.mood && <span>Mood: {call.mood}</span>}
      </p>
      <p className="hx-summary">{call.summary ? firstSentence(call.summary) : "No summary for this call."}</p>
      {events.length > 0 && (
        <ul className="hx-events" aria-label="During and right after this call">
          {events.map((e, n) => <li key={n}><EventLine e={e} /></li>)}
        </ul>
      )}
    </article>
  )
}

function EventLine({ e }: { e: Ev }) {
  const k = KIND[e.kind] ?? KIND.note
  const t = ms(e.created_at)
  return (
    <p className="hx-event" data-kind={e.kind}>
      <Icon name={k.icon} className="icon hx-icon" />
      <span>
        <b className="hx-kind">
          {e.kind === "agent_msg"
            ? <>{who(e.from_agent)} <span aria-hidden="true">→</span><span className="sr-only">to</span> {who(e.to_agent)}:</>
            : `${k.label}:`}
        </b>{" "}
        {e.text}
      </span>
      {!isNaN(t) && <time className="hx-time" dateTime={e.created_at}>{clock(t)}</time>}
    </p>
  )
}
