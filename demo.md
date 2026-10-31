# Troska — facts and figures for the demo

A cheat sheet for the 2-minute demo and the judges' questions. The demo script itself is in
[PLAN.md, Demo](PLAN.md#demo-the-centerpiece-one-person-talks-the-screen-shows-the-context-live).

Rules for what we say on stage (from [PRODUCT.md](PRODUCT.md)):
- Public figures only with their source.
- Our own numbers are the ones measured today, on the live system.
- We have no customers, pilots, pricing or testimonials. Don't imply any.
- Grandpa Joe Nguyen, his daughter Linh and Dr. Patel are **fictional**, and so are their medications.

## The one-liner

**Troska gives an aging parent a care team.** A voice agent phones the elder for a check-in: it confirms the meds,
runs a teach-back and hears when something is off. Behind the call, doctor, pharmacy and family agents work the case
directly with each other. One durable actor per elder remembers everything and schedules the next call. The parent can
also call Troska back, any time, on the same number.

## Why now: YC asked for this

- **YC Request for Startups, Fall 2026: "AI for the Aging Population"** (listed under Max Kolysh). Quoted from a
  [mirror of the RFS](https://modelence.com/yc-rfs-fall-2026/ai-for-the-aging-population); YC's
  [own RFS page](https://www.ycombinator.com/rfs) now shows only Winter 2027. Each ask, and how Troska answers it:

  | The RFS asks | Troska |
  |---|---|
  | "The population is aging and there aren't enough caregivers." | A care team of agents does the coordination a family member does today. |
  | "...natural voice interfaces" | A real phone call. Nothing to install, no screen for the elder. |
  | "The system must serve two users well: the senior and their family/caregivers." | The elder gets the call. The family gets plain-English texts and a live dashboard. |
  | "Escalate to the right person when something needs attention" | The doctor agent triages to ok / watch / urgent. Urgent means 911 advice, the human clinician paged and the family told. |

- **YC Request for Startups, Winter 2027: "The $15-an-Hour Expert"** (Brad Flora,
  [ycombinator.com/rfs](https://www.ycombinator.com/rfs)): AI turns people without formal credentials into experts. It
  doesn't mention elder care, so use it only as an analogy. Our analogy: a family caregiver with no medical
  training gets a doctor, a pharmacist and a coordinator working with them.

## The problem in numbers (sourced)

| Figure | Source |
|---|---|
| **63 million** Americans, nearly **1 in 4 adults**, are family caregivers, **up 20 million** from 2015 to 2025 | [AARP & National Alliance for Caregiving, *Caregiving in the U.S. 2025*](https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html) |
| Nearly **1 in 4** caregivers give **40+ hours** of care a week. **Nearly half** had at least one major financial impact. **1 in 5** are in fair or poor health themselves. | same report |
| **Over half** of caregivers manage complex tasks like medication management, but just **over 20%** ever got formal training on medical and nursing tasks | same report |
| **34.5%** of U.S. adults aged 60–79 used **five or more** prescription drugs in the past 30 days | [CDC, NCHS Data Brief No. 347](https://www.cdc.gov/nchs/products/databriefs/db347.htm) (2015–2016 data) |
| Adherence to long-term therapy for chronic disease averages only **50%** in developed countries | [WHO, *Adherence to long-term therapies* (2003)](https://www.who.int/news/item/01-07-2003-failure-to-take-prescribed-medicine-for-chronic-diseases-is-a-massive-world-wide-problem) |
| **Over 14 million**, or **1 in 4**, older adults report falling every year. Falls are the **leading cause of injury** for adults 65+. The fall death rate **rose 21%**, from 64.7 to 78.4 per 100,000 older adults (2018 → 2024). | [CDC, Older Adult Falls Data](https://www.cdc.gov/falls/data-research/index.html) |

The story these numbers tell: millions of untrained family members are the care coordinators for parents on
five or more medications, and half of those medications aren't taken as prescribed. Troska puts a trained care team
behind every call, and checks that the parent actually understood (teach-back).

## What we measured today (live system, Oct 31)

**The real phone call (2:26 PM):**
- The Terse cloud alarm fired at 21:25:55 UTC, and the server dialed through ElevenLabs **2 s later**. Mian answered as Grandpa.
- "I'm about to die, I think" became a high-severity symptom. The doctor agent's **URGENT** triage arrived **4 s** after he said it, and the family agent's text to Linh **7 s** after.
- The call lasted **109 s**. After hang-up, ElevenLabs' signed webhook closed the call, and Supabase stored the **21-turn transcript**.

**`bun e2e.ts`, ALL PASS on `main`.** It ran against the cloud actor, real OpenAI and real Agent Relay:
- Doctor, pharmacy and family **all answered 1.6 s** after the symptom. The target is 12 s.
- **10 real Agent Relay messages** per call, each with a relay message id, and **0** fallbacks to canned replies.
- **One case per call**, and each medication is refilled **once**.
- The Terse alarm delivered `call_due` about **2.8 s** after its scheduled time.

**Tests:** server 39, care-team 10, web 11 plus a production build, actor typecheck. All green.

## How it's built (prize map)

| Track | What judges should notice |
|---|---|
| **Durable Actors (Terse)**: iPhone | One `ElderActor` per elder, **deployed to Terse cloud**. It holds the meds, status and timeline, and its **own alarm** places the next call. Restart our server and nothing is lost: the state and the pending recheck live in the actor. |
| **Agent Relay**: Mac mini | **4 agents** (caretaker, doctor, pharmacy, family) message each other on a real Agent Relay channel plus DMs. Each agent acts only on what Relay delivers to it, and every message is mirrored to the live Care Feed. |
| **Both**: bonus | The actor is the memory and the scheduler, and Relay is the coordination. Each does a job the other can't. |
| **Supabase**: "most likely to scale to millions" | Postgres is the system of record: **6 tables** with row-level security per family (patients, prescriptions, clinical notes, calls, care events, family members). Every call, tool event and agent message is stored. The hot state per elder lives in actors, which scale out one elder at a time. |
| **OpenAI** | The agents' brains (`gpt-6-luna`), plus the browser voice fallback (`gpt-realtime-2.1`). |
| **ElevenLabs + Twilio** | The phone voice. It calls the elder, and the elder can call it. |

## Safety and privacy (likely judge questions)

- **Troska never diagnoses.** The doctor agent triages and escalates to humans.
- **A safety floor the AI can't override.** Chest pain, trouble breathing, fainting, a fall, slurred speech,
  high severity, or a heart rate of 130+ or 40 or below are always urgent. The model can raise urgency, never lower it.
  An urgent case means 911 advice, the human clinician paged, the family told to go now, and a recheck in 60 s.
- **It never rings over a live call.** A recheck that comes due mid-call waits, in both the actor and the server.
- **An unknown number calling in** gets "confirm who you're speaking with" before anything personal is discussed.
- **Dignity over surveillance.** The dashboard shows what the agent extracted (meds, symptoms, teach-back), not a raw
  transcript. Family members see only their own parent's data (Supabase RLS). Service keys stay server-side.

## Lines that land

- "No parent ages alone."
- "A care team that never forgets."
- "The agents talk to each other, so the family doesn't have to play telephone."
- "Grandpa's own phone rings. There's no app to install."
- "It checks that he understood, not just that he was reminded."
