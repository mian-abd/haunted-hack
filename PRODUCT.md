# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + React + TypeScript single-page app in `web/`, with two routes: `/` is the landing page and `/live` is the demo dashboard. The user asked for "Next.js or whatever React app works, keep it simple". Delegated choice: we kept the Vite app that was already scaffolded, because switching frameworks costs a rebuild with no gain for the demo. It deploys as a static build.

## Users

- Primary today: judges at Haunted Hacks (Real-Time AI Edition, Oct 31 2026, San Francisco). They decide prizes from a 2-minute live demo and the submission page.
- Secondary: adult children of aging parents, the people who would actually adopt Unc. The landing page must be credible to them too.
- The dashboard has no in-story user. It is a demo screen that shows judges the system working live.

## Product Purpose

Unc gives an aging parent a care team. A voice agent makes check-in calls to the elder: it confirms medications, runs teach-back, and notices when something is off. Behind the call, doctor, pharmacy and family agents work the case directly with each other. A durable memory per elder keeps the whole story and schedules the next call.

Mission line: **"No parent ages alone."**

Success today: win the Best Agent Relay prize. The agent-to-agent conversation is the hero, and judges understand the product within seconds.

## Positioning

Three equal pillars that a plain "AI that calls grandma" cannot claim together:

1. **The care team coordinates itself.** Doctor, pharmacy and family agents talk to each other over Agent Relay, so the family stops relaying messages.
2. **It never forgets.** One durable actor per elder holds its state, schedules its own follow-up calls, and survives restarts.
3. **Teach-back.** It checks that the elder understood, not just that they were reminded.

## Operating Context

- The live demo runs from one laptop, shown both on a projector and up close.
- Demo story: Grandpa Joe (fictional, 78) gets a check-in call. He is dizzy and has run out of his blood-pressure pills. The doctor agent triages, the pharmacy agent readies a refill, and the family agent messages his daughter. His status moves to "watch" and a recheck is scheduled.
- A teammate plays the elder, and the room hears both voices.

## Capabilities and Constraints

- The dashboard covers one elder only (Grandpa Joe): live status (ok / watch / urgent), meds, a next check-in countdown, three Care Feed lanes (Doctor / Pharmacy / Family) and the agent thread.
- Agent-to-agent messages are shown as their real, short text.
- No raw transcript on screen. During a call the dashboard shows only what the agent extracted: meds confirmed, symptoms reported, teach-back results. Privacy comes first.
- If voice or network fails, a scripted mode replays the storyline through the same UI, labeled "scripted" in small text.
- Built with Terse Durable Actors, Agent Relay, Supabase and OpenAI Realtime.
- Unc never diagnoses; it escalates to humans.
- Undecided: the final product name. "Unc" is a placeholder.

## Brand Commitments

- Name: "Unc" (placeholder, may change).
- Voice: confident startup. Crisp, outcome- and mechanism-forward, no jargon dumps.
- Must not feel: like a generic AI-SaaS template, clinical or cold, too busy, or childish and cutesy.
- No Halloween theme, even though it's a Halloween event.
- No team section.

## Evidence on Hand

- The live demo itself (the product running with real agent traffic) is the primary proof.
- Public statistics may be used only when cited and linked to their source.
- These do not exist and must not be invented: testimonials, customers, pilots, usage numbers, pricing, partnerships. A caregiver validation clip may be recorded today; use it only if it exists.
- The demo people (Grandpa Joe, his daughter Linh, Dr. Patel) and their medications are fictional, and must be labeled that way wherever a visitor could mistake them for real.

## Product Principles

1. Show it working, live. Real agent traffic beats any claim.
2. The agents' conversation is the hero.
3. One glance tells you how the elder is doing.
4. Dignity over surveillance: summaries, not transcripts. The elder is a person, not a record.
5. Escalate to humans; never diagnose.

## Accessibility & Inclusion

- Must read on a projector from the back of the room and up close: large type, strong contrast.
