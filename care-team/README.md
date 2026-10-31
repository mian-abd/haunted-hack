# care-team/ — the Unc care team on Agent Relay (YCH-3)

Four agents, **caretaker**, **doctor**, **pharmacy**, and **family**, work each case by messaging each other on **Agent Relay**: channel `#care-<elderId>` plus DMs. Every relay message is mirrored to `ElderActor.logEvent({ kind: "agent_msg", data: { lane } })`, and those events are the live Care Feed.

Owner: Mian (P3). Contract: the `care-team/` section of [PLAN.md](../PLAN.md).

## Run

```bash
cd care-team
bun install
cp .env.example .env      # then fill in RELAY_WORKSPACE_KEY and OPENAI_API_KEY
bun run smoke:relay       # proves real Agent Relay delivery (do this once before the demo)
bun run dev               # http://localhost:8788
bun test                  # storyline, dedupe, safety floor, HTTP
```

| Env | What happens if it is missing |
|---|---|
| `RELAY_WORKSPACE_KEY` | Falls back to an in-process relay, and `/health` shows a warning. **Not for the demo.** Get a key with `npx -y agent-relay@next init --hosted`. |
| `OPENAI_API_KEY` | Scripted mock mode: the same storyline, deterministic, with no API calls. If an LLM turn fails or times out, that turn falls back to scripted text. |
| `care-team/generated/` | The console actor prints actor calls instead of sending them. Once `actor/` runs, run `terse actor generate` in `care-team/`. |
| `SUPABASE_URL` + key | Reads `../supabase/seed.json`, then a built-in demo record. |

## HTTP

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/escalate` | `{ elderId, kind: "symptom"\|"refill"\|"vitals"\|"summary"\|"teach_back", reason, details? }` returns **202** `{ accepted, caseId }`. The conversation runs in the background. |
| `GET` | `/health` | `{ ok, relay: "agent-relay"\|"memory", actor: "terse"\|"console", llm: "openai"\|"scripted", records }` |
| `POST` | `/demo/storyline` | `{ elderId?, speed? }` replays the PLAN.md demo escalations (dizzy, refill, metformin teach-back, summary). Use it for the "Run scripted demo" button. |
| `GET` | `/debug/feed?elderId=` | Recent relay messages as the care team saw them |
| `GET` | `/debug/cases?elderId=` | Open cases, with the triage result and next check-in |

What `details` the server should send (all optional): `symptom` → `{ symptom, severity }`, `refill` → `{ med }`, `vitals` → `{ heartRate, note }`, `teach_back` → `{ med, understood }`, `summary` → `{ mood }`.

## Turn order: every agent acts only on a message Agent Relay delivered to it

```
POST /escalate
  symptom | vitals    caretaker  → #care-<elder> → doctor            step "case"            lane doctor
  refill              caretaker  → @pharmacy                        step "refill_request"  lane pharmacy
  teach_back | summary caretaker → @family                          step "family_brief"    lane family
doctor gets case      doctor     → #care-<elder> → caretaker        step "triage"          lane doctor   { urgency, actions[], recheck }
caretaker gets triage → actor.setStatus(urgency) + actor.scheduleCheckIn(now + recheck)
                      caretaker  → #care-<elder> → doctor           step "recheck"         lane doctor
                      caretaker  → @pharmacy (if he is out of a med) step "refill_request"  lane pharmacy
                      caretaker  → @family                          step "family_brief"    lane family
pharmacy gets request pharmacy   → #care-<elder> → caretaker        step "refill_confirmed" lane pharmacy  "Ready at 5 pm"
family gets brief     family     → #care-<elder> → family-contact   step "family_draft"    lane family   "To Linda (daughter): …"
```

- **Lanes:** every message has exactly one lane, set in `data.lane`. The dashboard groups `agent_msg` events by `data.lane`, and the full thread is all of them in time order. `data` also carries `step`, `urgency`, `caseId`, `messageId`, `channel`, and `via` (`agent-relay` or `memory`).
- **One case per elder:** escalations within `CASE_WINDOW_MS` (3 min) join the open case, so one call yields one thread, and each medication is refilled only once.
- **Safety:** the doctor agent triages and never diagnoses. Rule-based danger signs (chest pain, fainting, a fall, slurred speech, heart rate ≥130 or ≤40, severity high) always produce `urgent`, and the LLM can raise urgency but never lower it. Urgent cases tell the family to call 911 and page the human clinician.
- **Recheck timing for the demo:** watch = `DEMO_RECHECK_SECONDS` (90 s), urgent = `URGENT_RECHECK_SECONDS` (60 s).

## Agent Relay notes (from `@agent-relay/sdk` 15.0.1)

- Registration is create-only: registering an existing name fails with `name_conflict` (409). Agent tokens are therefore saved to `.relay-agents.json` (git-ignored), and restarts reconnect with them. If a token is lost, the agent is released and registered again.
- The four agents share one process, and the SDK's listener fans in through every registered agent, so the same message can arrive several times. The care team acts on and mirrors each message id once.
- Routing info travels in message `metadata`. If metadata ever fails to round-trip, the care team uses its own record of what it sent.

## For teammates

- **server/ (Krzysztof):** call `POST http://localhost:8788/escalate` with the kinds above, and treat 202 as success. Nothing else is needed.
- **actor/ (Krzysztof):** care-team calls `logEvent`, `setStatus`, and `scheduleCheckIn` via `actors.ElderActor.get(elderId)` from `care-team/generated/`. If the generated client exposes a different accessor, tell Mian, and adapt `src/actor.ts`.
- **web/ + supabase/ (Vi):** use the lanes as described above. The built-in fallback record uses Joe Miller (82), lisinopril 10 mg at 08:00 (blood pressure), metformin 500 mg at 08:00/18:00 (blood sugar), Dr. Patel, and daughter Linda. Please keep `seed.json` names in sync, or tell Mian what you picked.
