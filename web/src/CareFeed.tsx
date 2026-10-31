import { memo, useEffect, useState, type CSSProperties } from "react"
import { Icon } from "./CallPanel"
import { LANES, agentThread, groupLanes, type Lane, type TimelineEvent } from "./state"
import "./CareFeed.css"

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const sentAt = (ts: number) => new Date(ts).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })
const PERSON: Record<Lane, string> = { doctor: "doctor", pharmacy: "pharmacy", family: "family-contact" }
// Map positions in % of the map box: the coordinator in the middle, the three people around it.
const HUB = { x: 50, y: 46 }
const SPOT: Record<Lane, { x: number; y: number }> = { doctor: { x: 17, y: 20 }, pharmacy: { x: 83, y: 20 }, family: { x: 50, y: 84 } }
const PHOTO: Record<Lane, string> = { doctor: "/press/doctor.webp", pharmacy: "/press/pharmacy.webp", family: "/press/linh.webp" }

/** A round photo; a missing file falls back to the person's initial. */
function Avatar({ src, name }: { src: string; name: string }) {
  const [broken, setBroken] = useState(false)
  return broken
    ? <span className="cf-face cf-initial" aria-hidden="true">{name.charAt(0)}</span>
    : <img className="cf-face" src={src} alt="" width={96} height={96} onError={() => setBroken(true)} />
}

export const CareFeed = memo(function CareFeed({ timeline, familyName, relation }: { timeline: TimelineEvent[]; familyName?: string; relation?: string }) {
  const family = familyName ?? "the family"
  const title: Record<Lane, string> = { doctor: "Doctor", pharmacy: "Pharmacy", family: familyName ? (relation ? `${familyName} (${relation})` : familyName) : "Family" }
  // Plain names: every care-team agent of ours is "Troska"; only the doctor, the pharmacy and the family member are outside people.
  const who = (a?: string) => (a === "doctor" ? "the doctor" : a === "pharmacy" ? "the pharmacy" : a === "family-contact" ? family : "Troska")
  const told = (e: TimelineEvent) => { const s = `${who(e.from)} told ${who(e.to)}`; return s.charAt(0).toUpperCase() + s.slice(1) }

  const lanes = groupLanes(timeline)
  const all = agentThread(timeline).reverse()
  const [filter, setFilter] = useState<Lane | null>(null)
  const [seen, setSeen] = useState<Record<Lane, number>>({ doctor: 0, pharmacy: 0, family: 0 })
  const [flight, setFlight] = useState<{ id: string; lane: Lane; back: boolean } | null>(null)

  // A new message: a dot travels the wire between the coordinator and that person (back toward the coordinator for a reply).
  const newest = all.find(e => e.data?.lane && LANES.includes(e.data.lane))
  useEffect(() => {
    const lane = newest?.data?.lane
    if (newest && lane) setFlight({ id: newest.id, lane, back: newest.from === PERSON[lane] })
  }, [newest?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = filter ? lanes[filter].length : 0
  useEffect(() => { if (filter) setSeen(s => ({ ...s, [filter]: open })) }, [filter, open])

  const shown = filter ? all.filter(e => e.data?.lane === filter) : all

  return (
    <div className="cf">
      <section className="cf-sec cf-circle" aria-labelledby="cf-circle-title">
        <h2 id="cf-circle-title">Care circle</h2>
        <p className="cf-sub">{all.length ? "Tap a person to see only what they were told." : "When Troska hears something on a call, it tells the right person here."}</p>
        <div className="cf-map">
          <svg className="cf-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {LANES.map(l => <line key={l} x1={HUB.x} y1={HUB.y} x2={SPOT[l].x} y2={SPOT[l].y} className={filter === l ? "is-on" : undefined} />)}
          </svg>
          {flight && (
            <span key={flight.id} className={`cf-flight${flight.back ? " is-back" : ""}`} aria-hidden="true"
              style={{ "--dx": `${SPOT[flight.lane].x - HUB.x}%`, "--dy": `${SPOT[flight.lane].y - HUB.y}%` } as CSSProperties}>
              <i style={{ left: `${HUB.x}%`, top: `${HUB.y}%` }} />
            </span>
          )}
          <div className="cf-hub" style={{ left: `${HUB.x}%`, top: `${HUB.y}%` }}>
            <span className="cf-mark" aria-hidden="true">T</span>
            <p className="cf-hub-name">Troska's care coordinator</p>
          </div>
          {LANES.map(lane => {
            const total = lanes[lane].length
            const unread = filter === lane ? 0 : total >= seen[lane] ? total - seen[lane] : total // fewer than seen: the demo was reset
            const latest = lanes[lane][0]
            return (
              <button key={lane} type="button" className="cf-node" aria-pressed={filter === lane}
                style={{ left: `${SPOT[lane].x}%`, top: `${SPOT[lane].y}%` }}
                onClick={() => setFilter(f => (f === lane ? null : lane))}>
                <span className="cf-ava">
                  <Avatar src={PHOTO[lane]} name={title[lane]} />
                  {flight?.lane === lane && <span key={flight.id} className={`cf-pulse${flight.back ? " is-back" : ""}`} aria-hidden="true" />}
                  {unread > 0 && <span className="cf-badge" aria-label={`${unread} new`}>{unread}</span>}
                </span>
                <span className="cf-node-title">{title[lane]}</span>
                <span className="cf-node-meta">{latest ? `${total} message${total === 1 ? "" : "s"} · ${clock(latest.ts)}` : "Nothing yet"}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="cf-sec cf-updates" aria-labelledby="cf-updates-title">
        <div className="cf-head">
          <h2 id="cf-updates-title">Updates</h2>
          {filter && (
            <p className="cf-filter">
              Only {title[filter]}
              <button type="button" className="cf-reset" onClick={() => setFilter(null)}>Show all</button>
            </p>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="cf-empty">{filter ? `Nothing for ${who(PERSON[filter])} yet. When a call turns up something they should know, it shows up here.` : "No one has needed an update yet today. After each call, every message Troska sends shows up here, newest first, in plain words."}</p>
        ) : (
          <ol className="cf-list" aria-live="polite">
            {shown.map(e => (
              <li key={e.id} className="cf-row">
                <details>
                  <summary>
                    <span className="cf-meta">{told(e)} · <time dateTime={new Date(e.ts).toISOString()}>{clock(e.ts)}</time></span>
                    <span className="cf-text">{e.text}</span>
                    <Icon name="chevron" className="icon cf-chev" />
                  </summary>
                  <p className="cf-full">Sent {sentAt(e.ts)}</p>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
})
