import { useEffect, useReducer, useRef, useState } from "react"
import { CareFeed } from "../CareFeed"
import { playMock } from "../mock"
import { EMPTY, reduce } from "../state"

const VIDEO_URL: string | undefined = import.meta.env.VITE_DEMO_VIDEO_URL
const STATUS_LABEL = { ok: "OK", watch: "Watch", urgent: "Urgent" }

const PILLARS = [
  ["The care team coordinates itself.", "Doctor, pharmacy and family agents message each other directly over Agent Relay. The case gets worked without the family relaying messages."],
  ["It never forgets.", "One durable actor per elder holds the meds, the history and the status. It schedules its own follow-up calls and survives restarts."],
  ["Teach-back.", "Unc asks your parent to explain their medicines in their own words. It checks they understood, not just that they were reminded."],
]

const STEPS = [
  ["The check-in call", "On schedule, a voice agent calls. It asks how they feel, goes through each medicine and runs a teach-back. What it hears becomes structured events, not a transcript."],
  ["The care team on Agent Relay", "Anything worth acting on opens a case. The doctor agent triages against the hospital record, the pharmacy agent handles the refill and the family agent drafts the update."],
  ["The memory and the next call", "The elder's durable actor records every event, sets their status to ok, watch or urgent, and schedules the recheck call itself."],
]

// Each figure checked against its primary source on Oct 31 2026.
const STATS = [
  {
    body: <><strong className="stat-figure">63 million</strong> Americans, nearly 1 in 4 adults, are family caregivers.</>,
    source: "AARP and National Alliance for Caregiving, Caregiving in the U.S. 2025",
    href: "https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html",
  },
  {
    body: <><strong className="stat-figure">34.5%</strong> of U.S. adults aged 60 to 79 used five or more prescription drugs in the past 30 days.</>,
    source: "CDC, NCHS Data Brief No. 347 (2015–2016 data)",
    href: "https://www.cdc.gov/nchs/products/databriefs/db347.htm",
  },
  {
    body: <>In developed countries, “adherence among patients suffering from chronic diseases averages only <strong className="stat-figure">50%</strong>.”</>,
    source: "World Health Organization, Adherence to long-term therapies (2003)",
    href: "https://www.who.int/news/item/01-07-2003-failure-to-take-prescribed-medicine-for-chronic-diseases-is-a-massive-world-wide-problem",
  },
]

const SAFETY = [
  ["Never diagnoses.", "Unc doesn't diagnose or change doses. The doctor agent triages; it never starts a new drug or tells anyone to double a missed dose."],
  ["Escalates to humans.", "Danger signs like chest pain or fainting get one answer: call 911 now. When in doubt, the care team hands the case to people."],
  ["Summaries, not transcripts.", "Families see meds taken or missed, symptoms, teach-back results and a short summary. The call archive keeps the summary and mood, not the conversation."],
]

const BUILT_WITH = [
  ["Terse Durable Actors", "One actor per elder: memory, status and the alarm for the next call."],
  ["Agent Relay", "The care team's agent-to-agent messaging."],
  ["Supabase", "Hospital records and the call archive."],
  ["OpenAI Realtime", "The voice of the check-in call."],
]

const FAQ = [
  ["Is the demo really live?", "Yes. It runs a real voice call, real Agent Relay messages between the agents and a durable actor that holds the state. If voice or the network fails, a scripted mode replays the same story through the same screen and labels itself as scripted."],
  ["Does Unc diagnose or change medicines?", "No. It never diagnoses and never changes doses. For danger signs it tells your parent to call 911, and the care team hands the case to people when in doubt."],
  ["What does the family see?", "Summaries, not transcripts: meds taken or missed, symptoms, teach-back results, the care team's updates and a short note after each call."],
  ["Does it call a real phone?", "Not in this demo. The check-in call runs in the browser over OpenAI Realtime."],
  ["What happens if a server restarts mid-case?", "Nothing is lost. Each elder's actor is durable: its state and its next scheduled call survive restarts."],
  ["Are Joe, Linh and Dr. Patel real?", "No. The demo patient, his daughter, his doctor and his medications are fictional."],
]

/** The mock.ts storyline through the dashboard's own reducer and Care Feed. Starts when scrolled into view. */
function Replay() {
  const [state, dispatch] = useReducer(reduce, EMPTY)
  const [run, setRun] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (run) return playMock(dispatch)
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setRun(1), { threshold: 0.25 })
    io.observe(box.current!)
    return () => io.disconnect()
  }, [run])
  return (
    <div ref={box} className="replay-box">
      <div className="replay-bar">
        <p className="replay-label">Sample run · fictional patient</p>
        <p className="replay-status" aria-live="polite">
          Status: <strong>{STATUS_LABEL[state.status]}</strong>
          {state.statusReason && <span className="muted"> · {state.statusReason}</span>}
        </p>
        <button className="btn btn-small" onClick={() => setRun(r => r + 1)}>Replay</button>
      </div>
      <CareFeed timeline={state.timeline} familyName={state.profile?.family.name} />
    </div>
  )
}

export function Landing() {
  return (
    <div className="landing">
      <header className="site-head">
        <a className="logo" href="/">Unc</a>
        <a className="nav-link" href="/live">Live demo</a>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title">No parent ages alone.</h1>
          <p className="hero-sub">Unc is an AI care team for aging parents: a voice agent checks in, and doctor, pharmacy and family agents work the case together, live.</p>
          <div className="actions">
            <a className="btn btn-primary" href="/live">Try the live demo</a>
            {VIDEO_URL && <a className="btn" href={VIDEO_URL} target="_blank" rel="noreferrer">Watch the demo video</a>}
          </div>
          <p className="hero-proof">The live demo is the real system: a voice call on OpenAI Realtime, agents messaging each other on Agent Relay, and a durable actor per elder.</p>
        </section>

        <section className="section replay" aria-labelledby="replay-title">
          <h2 id="replay-title">Watch the agents talk.</h2>
          <p className="section-lede">Joe, 78, is dizzy and out of his blood-pressure pills. The doctor agent triages, the pharmacy agent readies a refill and the family agent messages his daughter, all over Agent Relay.</p>
          <Replay />
        </section>

        <section className="section" aria-labelledby="pillars-title">
          <h2 id="pillars-title">More than a reminder call.</h2>
          <ul className="pillars">
            {PILLARS.map(([title, body]) => (
              <li key={title} className="pillar">
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="section" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="steps">
            {STEPS.map(([title, body]) => (
              <li key={title} className="step">
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="section" aria-labelledby="why-title">
          <h2 id="why-title">Why it matters</h2>
          <ul className="stats">
            {STATS.map(s => (
              <li key={s.href} className="stat">
                <p>{s.body}</p>
                <a className="stat-source" href={s.href} target="_blank" rel="noreferrer">{s.source}</a>
              </li>
            ))}
          </ul>
        </section>

        <section className="section" aria-labelledby="safety-title">
          <h2 id="safety-title">Safety and privacy</h2>
          <ul className="safety">
            {SAFETY.map(([title, body]) => (
              <li key={title} className="safety-item">
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="section" aria-labelledby="built-title">
          <h2 id="built-title">Built with</h2>
          <ul className="built">
            {BUILT_WITH.map(([name, role]) => (
              <li key={name} className="built-item">
                <strong>{name}</strong>
                <span>{role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="section" aria-labelledby="faq-title">
          <h2 id="faq-title">Questions</h2>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q} className="faq-item">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="section closing" aria-labelledby="closing-title">
          <h2 id="closing-title">See the care team work a case.</h2>
          <p className="section-lede">Joe is dizzy and out of his pills. Watch the agents handle it, live.</p>
          <a className="btn btn-primary" href="/live">Try the live demo</a>
        </section>
      </main>
    </div>
  )
}
