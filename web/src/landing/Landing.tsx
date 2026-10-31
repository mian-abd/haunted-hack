import type { CSSProperties } from "react"
import { embedFor } from "./embed"
import { Actions, Example, Icon, TROSKA_TEL, useInView, Vignette } from "./parts"
import "./landing.css"

const VIDEO = embedFor(import.meta.env.VITE_DEMO_VIDEO_URL)

const STEPS = [
  ["phone", "Troska talks with your parent on their own phone (no app)."],
  ["listen", "It listens for medicines, symptoms, and whether they understood."],
  ["note", "Its care coordinator updates the doctor's office and the pharmacy, and texts you a plain update."],
] as const

// Written like the real system's messages. Joe, Linh and Dr. Patel are fictional.
const GETS = [
  {
    title: "What the family gets",
    route: "Text from Troska to Linh (daughter)",
    text: "Dad is OK but a little dizzy. He ran out of his blood-pressure pills, so the pharmacy has a refill ready at 5 PM. Troska will call him again at 3:10.",
  },
  {
    title: "What the doctor gets",
    route: "Note from Troska's care coordinator to Dr. Patel's office",
    text: "Joe Nguyen, 78. Dizzy since this morning; missed amlodipine for 2 days. No red-flag symptoms reported. Refill requested; recheck call in 2 hours.",
  },
]

export function Landing() {
  const [stepsRef, stepsIn] = useInView<HTMLOListElement>(true)
  return (
    <div className="lp">
      <header className="lp-head lp-wrap">
        <a className="lp-wordmark" href="/">Troska</a>
        <nav className="lp-nav" aria-label="Main">
          <a className="lp-nav-watch" href="/doctor">For doctors and families</a>
          <a className="lp-nav-watch" href="/live">Watch it live</a>
          <a className="lp-nav-call" href={TROSKA_TEL}><Icon name="phone" />Call Troska</a>
        </nav>
      </header>

      <main>
        <section className="lp-hero lp-wrap" aria-labelledby="hero-title">
          <div>
            <h1 id="hero-title">No parent ages alone.</h1>
            <p className="lp-lede">Troska calls your mom or dad every day, checks their medicines, and keeps their doctor, pharmacy and you in the loop.</p>
            <Actions />
          </div>
          <Vignette />
        </section>

        <section className="lp-section lp-wrap" aria-labelledby="how-title">
          <h2 id="how-title">What happens when you call</h2>
          <ol className="lp-steps" ref={stepsRef} data-in={stepsIn || undefined}>
            {STEPS.map(([icon, text], i) => (
              <li key={icon} style={{ "--i": i } as CSSProperties}>
                <span className="lp-step-icon"><Icon name={icon} /></span>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        {VIDEO && (
          <section className="lp-section lp-wrap" aria-labelledby="see-title">
            <h2 id="see-title">See it work</h2>
            <div className="lp-video">
              {VIDEO.kind === "video"
                ? <video src={VIDEO.src} controls preload="metadata" />
                : <iframe src={VIDEO.src} title="Troska demo video" loading="lazy" allow="fullscreen; picture-in-picture" allowFullScreen />}
            </div>
          </section>
        )}

        <section className="lp-section lp-wrap lp-gets" aria-label="What the family and the doctor get">
          {GETS.map(g => <Example key={g.title} {...g} />)}
        </section>

        <section className="lp-section lp-wrap" aria-label="Safety and privacy">
          <p className="lp-trust">Troska never diagnoses. It escalates to people. Families see summaries, not transcripts.</p>
        </section>

        <section className="lp-closing" aria-labelledby="closing-title">
          <div className="lp-wrap">
            <h2 id="closing-title">Hear Troska for yourself.</h2>
            <p>Call Troska's line and talk with it, or watch a check-in call as it happens.</p>
            <Actions />
          </div>
        </section>
      </main>

      <footer className="lp-foot lp-wrap">
        <p>Built with Terse durable actors · Agent Relay · Supabase · OpenAI · ElevenLabs</p>
        <p><a href="/doctor">Doctors and families: sign in to the patient record</a></p>
        <p>Joe and his family are fictional demo characters.</p>
      </footer>
    </div>
  )
}
