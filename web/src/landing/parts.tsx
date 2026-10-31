import { useEffect, useRef, useState } from "react"

export const TROSKA_PHONE = "+1 (681) 206-8273"
export const TROSKA_TEL = "tel:+16812068273"

const ICONS = {
  phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />,
  listen: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>,
  note: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  check: <path d="M20 6 9 17l-5-5" />,
}

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[name]}</svg>
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/** True while the element is on screen; with `once`, true from the first time it shows. */
export function useInView<T extends Element>(once = false) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => {
      setInView(e.isIntersecting)
      if (once && e.isIntersecting) io.disconnect()
    }, { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, [once])
  return [ref, inView] as const
}

/** The page's one primary action (it rings while on screen), plus the quiet way to watch instead. */
export function Actions() {
  const [ref, live] = useInView<HTMLDivElement>()
  return (
    <div className="lp-actions" ref={ref} data-live={live || undefined}>
      <a className="btn btn-primary lp-call" href={TROSKA_TEL}><Icon name="phone" />Call Troska · {TROSKA_PHONE}</a>
      <a className="lp-watch" href="/live">Watch it live</a>
    </div>
  )
}

const HEARD = ["Dizzy since this morning", "Missed his blood-pressure pill", "Understood the refill plan"]
const SENT = [
  ["Linh (daughter)", "Dad is OK, a little dizzy."],
  ["Dr. Patel's office", "Refill asked, recheck in 2 hours."],
]
// One beat a second: 0 the call alone, 1-3 notes, 4 Linh, 5 delivered, 6 Dr. Patel, 7 delivered, 8-11 hold, then loop.
const LAST = 7
const BEATS = 12

/** The hero's signature motion: one check-in call, what Troska heard, and who it told. */
export function Vignette() {
  const [ref, live] = useInView<HTMLDivElement>()
  const [beat, setBeat] = useState(() => (reducedMotion() ? LAST : 0))
  useEffect(() => {
    if (!live || reducedMotion()) return
    const id = setInterval(() => setBeat(b => (b + 1) % BEATS), 1000)
    return () => clearInterval(id)
  }, [live])
  const on = (n: number) => (beat >= n ? " is-on" : "")
  return (
    <div className="vg" ref={ref} data-live={live || undefined} role="group" aria-label="Example: one check-in call with Joe">
      <div className="vg-photo">
        <img src="/press/lead-joe.webp" width={1536} height={1024} fetchPriority="high" decoding="async"
          alt="An older man smiles at his kitchen table while talking on a cordless phone, a weekly pill organizer and a cup of tea beside him." />
        <p className="vg-pill"><span className="vg-bars" aria-hidden="true"><i /><i /><i /><i /></span>On the call with Joe</p>
      </div>
      <div className="vg-panel">
        <div>
          <p className="vg-label">Troska heard</p>
          <ul>{HEARD.map((t, i) => <li key={t} className={"vg-note vg-step" + on(i + 1)}>{t}</li>)}</ul>
        </div>
        <div>
          <p className="vg-label">Troska told</p>
          <ul>
            {SENT.map(([who, what], i) => (
              <li key={who} className={"vg-msg vg-step" + on(4 + 2 * i)}>
                <span className="vg-who"><b>{who}</b><span className={"vg-tick" + on(5 + 2 * i)}><Icon name="check" />Sent</span></span>
                <span className="vg-what">{what}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/** An example message: a short typing indicator, then the message, once it scrolls into view. */
export function Example({ title, route, text }: { title: string; route: string; text: string }) {
  const [ref, seen] = useInView<HTMLElement>(true)
  const [sent, setSent] = useState(reducedMotion)
  useEffect(() => {
    if (!seen || sent) return
    const id = setTimeout(() => setSent(true), 1400)
    return () => clearTimeout(id)
  }, [seen, sent])
  return (
    <article>
      <h2>{title}</h2>
      <figure className="lp-msg" ref={ref} data-state={sent ? "sent" : seen ? "typing" : "idle"}>
        <figcaption><span className="lp-tag">Example</span>{route}</figcaption>
        <div className="lp-msg-body">
          <span className="lp-typing" aria-hidden="true"><i /><i /><i /></span>
          <blockquote><p>{text}</p></blockquote>
        </div>
      </figure>
    </article>
  )
}
