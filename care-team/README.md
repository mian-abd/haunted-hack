# care-team: the Unc care team on Agent Relay

## Contract deviations

None. The PLAN.md contract is met as written. Three additions, all inside what the contract allows:

- `POST /escalate` returns `202 { accepted: true, caseId }`. PLAN.md only asks for the 202.
- Mirrored `agent_msg` events carry extra `data` keys next to `lane`: `type`, `caseId`, `urgency`, `actions`, `relayId`, `relayTs`, `via` and `relay`. The contract allows this through `[k: string]: unknown`.
- Messages arrive by polling, not WebSockets. Agents poll their Agent Relay delivery queue, because the hosted engine at `armadillo.agentrelay.com` does not serve WebSockets yet (it answers `501 websocket_unavailable`). Each hop takes about 0.5 s. The dizziness case finishes in about 2 s.

## What it is

There are four Agent Relay identities: `caretaker`, `doctor`, `pharmacy` and `family`. They run in one Bun process on port 8788. They talk to each other only through the hosted Agent Relay engine, Relaycast (`https://armadillo.agentrelay.com/v1`). They post in the channel `care-<elderId>` and send each other DMs. Each agent reacts only to the relay messages meant for it.

| # | from → to | how | lane | message `data.type` |
|---|---|---|---|---|
| 1 | caretaker → doctor | `#care-<elderId>` | doctor | `case` |
| 2 | doctor → caretaker | `#care-<elderId>` | doctor | `decision` with `{ urgency, actions[], recheck }` |
| 3 | doctor → pharmacy | DM | pharmacy | `refill_request` |
| 4 | doctor → family | DM | family | `notify_family` |
| 5 | pharmacy → doctor | `#care-<elderId>` | pharmacy | `refill_ready` ("Refill for Amlodipine 5 mg ready at 5 PM at the corner pharmacy.") |
| 6 | family → family-contact | `#care-<elderId>` | family | `family_message` (a warm text to the daughter) |

- **The caretaker routes, the others think.** The caretaker's handoff is a fixed sentence (`caseNote` in `src/brain.ts`), with no LLM call: it is instant and always addressed to the right teammate. The doctor, pharmacy and family replies come from the LLM, with length limits in their prompts, and every relay message is capped at 240 characters for the Care Feed.
- **Status and recheck.** When the caretaker receives the doctor's `decision`, it calls `setStatus(urgency, reason)`. If the doctor asked for a recheck, it also calls `scheduleCheckIn(now + RECHECK_SECONDS)`.
- **Mirroring.** Every message is sent first, then mirrored to the actor with `logEvent({ kind: "agent_msg", from, to, text, data: { lane, ... } })`. These events are the live Care Feed.
- **Routing by `kind`.** `symptom` and `vitals` go to the doctor, so the full flow above runs. `refill` goes straight to the pharmacy. `summary` and `teach_back` go to the family agent.
- **The doctor's record.** The doctor reads the hospital record from Supabase (`patients`, `prescriptions` and `clinical_notes` through PostgREST). If Supabase is not configured, it reads `../supabase/seed.json`. PostgREST gets `apikey`, plus `Authorization: Bearer` only for a legacy JWT key; a new `sb_secret_...` key is not a JWT and Supabase rejects it as a Bearer token (`supabaseAuth` in `src/records.ts`, unit-tested).

## Run it

```sh
cd care-team
cp .env.example .env        # optional: every value has a default, and no keys are needed for the demo
bun run start               # = bun src/index.ts, listens on :8788
```

Try it from another terminal:

```sh
curl localhost:8788/health
curl -X POST localhost:8788/escalate -H 'content-type: application/json' \
  -d '{"elderId":"grandpa-joe","kind":"symptom","reason":"dizzy this morning; ran out of his blood pressure pills (missed Amlodipine)","details":{"severity":"medium"}}'
bun test                    # case-flow tests (local bus + fake actor, no network)
```

The service log prints every relay message with its Agent Relay id and timestamp. Example:

```
[relay] 242372675181645824 2026-10-31T19:42:28.000Z caretaker -> #care-grandpa-joe: ...
[relay] doctor <- 242372675181645824 from caretaker ...
```

There are no npm dependencies. The service needs Bun 1.4+.

## Env vars (`care-team/.env`, git-ignored)

| var | default | what |
|---|---|---|
| `PORT` | `8788` | HTTP port |
| `OPENAI_API_KEY` | empty = **MOCK** | Agent brains (Chat Completions). Without a key, agents give canned replies that play the PLAN.md storyline. If an OpenAI call fails, that reply falls back to the mock. |
| `OPENAI_MODEL` | `gpt-6-luna` | Chosen by measurement on Oct 31 (see "Measured with the real key" below). |
| `OPENAI_REASONING_EFFORT` | `none` | Fastest on gpt-6-luna with the same output. Some models (gpt-6.1-sol) reject `none`: use `low`. A rejected call falls back to the mock reply and counts in `/health` `fallbacks`. |
| `RELAY_BASE_URL` | `https://armadillo.agentrelay.com` | Agent Relay (Relaycast) engine |
| `RELAY_WORKSPACE_KEY` | empty | Empty means each start creates a fresh 24-hour workspace anonymously, with no login. Set an `ar_ws_...` key to keep one workspace across restarts. |
| `RELAY_MODE` | empty | `local` turns on the **LOCAL FALLBACK**: an in-process bus for offline testing. That traffic is not Agent Relay, and `/health` shows `"relay":"local"`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | empty | Hospital records. Empty means `../supabase/seed.json`. |
| `TERSE_ACTOR_URL`, `TERSE_API_KEY` | empty | Only needed for a deployed actor. Local `terse actor dev` needs neither. |
| `TERSE_FAKE` | empty | `1` swaps in the in-memory fake actor. |
| `RECHECK_SECONDS` | `120` | Delay before the recheck call the doctor asks for |

To keep one workspace across restarts, mint a key in a private terminal. No login is needed. Copy `data.api_key` from the output into `.env` as `RELAY_WORKSPACE_KEY`; never commit it, paste it in chat or show it on screen:
`curl -s -X POST https://armadillo.agentrelay.com/v1/workspaces -H 'content-type: application/json' -d "{\"name\":\"unc-demo-$RANDOM\"}"`
With the key set, you can show the raw Agent Relay thread:
`curl -H "Authorization: Bearer $RELAY_WORKSPACE_KEY" https://armadillo.agentrelay.com/v1/channels/care-grandpa-joe/messages`. DMs are listed at `/v1/dm/conversations/all`.

## How it connects

- **server/ → care-team.** The server calls `POST http://localhost:8788/escalate` with `{ elderId, kind, reason, details? }`. care-team replies 202 at once and works the case asynchronously. A bad body gets a 400 with `{ error }`.
- **care-team → ElderActor.** Calls go through the generated client in `care-team/generated/`, which needs no npm packages and holds no secrets. It is committed, per actor/README. After any change to ElderActor's public API, regenerate it: keep `terse actor dev` running in `../actor`, then run `terse actor generate` here. If `generated/` is missing, or `TERSE_FAKE=1` is set, the service uses an in-memory fake that logs `[actor:fake] ...`. `/health` shows `"actor":"terse"` or `"actor":"fake"`.
- **care-team → Agent Relay.** `src/relay.ts` does the work in plain `fetch` calls:
  - Startup: `POST /workspaces` (anonymous), `POST /agents` four times. On a 409, the agent is deleted and registered again, because agent tokens are shown only once.
  - First case for an elder: `POST /channels` and `/join`.
  - Sending: `POST /channels/{name}/messages` and `POST /dm`.
  - Each agent's receive loop: `GET /deliveries`, then `GET /messages/{id}` (delivery items omit `metadata`), then `POST /deliveries/{id}/ack`.

## What is mocked

- **Brains.** Mock mode is used whenever `OPENAI_API_KEY` is empty. The mock doctor always returns the storyline decision: `watch`, refill Amlodipine, recheck in 2h, notify family, do not double the dose. The mock family text is written for Grandpa Joe texting his daughter.
- **Actor.** The in-memory fake is used only with `TERSE_FAKE=1` or when `generated/` is missing.
- **Relay.** The local bus is used only with `RELAY_MODE=local`, and is labeled in logs and `/health`. The real Agent Relay path is the default.
- **SMS.** There is no Twilio send. The family text shows up in the Family lane only (PLAN.md marks SMS as a stretch).

## Measured with the real key (Oct 31)

`bun e2e.ts` from the repo root, against the running stack (real OpenAI, real Agent Relay, real actor), scripted-demo tool sequence:

| hop | gpt-6-luna, effort low, LLM caretaker (before) | gpt-6-luna, effort none, template caretaker (now) |
|---|---|---|
| report_symptom → doctor decision | 8.2 s | 3.2 s |
| report_symptom → family message | 14.9 s | 5.6 s |
| request_refill → pharmacy refill ready | 4.0 s | 2.0 s |
| longest relay message | 504 chars | 218 chars |

Model check, 3 calls each with the shipped prompts (median doctor triage / family text): gpt-6-luna effort low 2.5 s / 1.1 s, effort none 1.7 s / 1.0 s; gpt-5.4-mini effort none 0.9 s / 0.7 s, but in one run it ordered a refill the case never mentioned (a duplicate pharmacy refill in the demo), and with the old prompts it invented care steps ("checking his blood sugar"). gpt-6-sol and gpt-6.1-sol were slower at similar quality. So gpt-6-luna stays the default.

## Known gaps

- **Polling, not push.** Polling runs every 0.5 s for 60 s after any traffic and every 2 s when idle. Switch to WebSockets once armadillo serves them. Agent Relay's own SDK (`@relaycast/sdk`) could do this today, but only against `cast.agentrelay.com`, which returned `503 database_overloaded` during testing.
- **History resets on restart.** Without `RELAY_WORKSPACE_KEY`, every restart starts a new workspace, so the relay channel history begins fresh. The actor timeline keeps the history.
- **At-most-once delivery.** An agent acks a delivery before handling it. If the handler throws, the error is logged and the message is not retried.
- **Mock copy is canned.** In mock mode, every symptom or vitals case gets the same dizziness/Amlodipine story. Real triage needs `OPENAI_API_KEY`.
