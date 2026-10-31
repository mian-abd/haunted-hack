# Troska — an AI care team for aging parents

Haunted Hacks: Real-Time AI Edition · Oct 31, 2026 · **submission 4:00 PM** (Builderbase)

> **13:20 change:** the check-in is now a **real phone call**: an ElevenLabs agent calls Grandpa from our Twilio number. Only the voice layer changes; the actor and the care team stay as they are. See [Decisions](#decisions).
>
> **14:50 status:** the product is named **Troska** (was "Unc"). The backend is live end to end: the ElderActor runs in **Terse cloud**, **Supabase** is the system of record, and the phone works **both ways** (Troska calls Grandpa, and Grandpa can call Troska). Facts and figures for the demo: [demo.md](demo.md).

## One-liner

Grandpa's phone rings: a check-in call from a voice agent. It checks his meds, runs a teach-back, and notices when something is off.
Behind the call, a care team of agents (doctor, pharmacy, family) works the case **directly with each other over Agent Relay**.
A **durable actor per elder** remembers everything and schedules the next call.
The family watches it all live: while Grandpa talks, the screen shows what is being sent to the doctor, the pharmacy, and the family.

## Why this wins (judging map)

| Prize / criterion | How we hit it |
|---|---|
| Durable Actors (Terse) — iPhone | One `ElderActor` per elder: persisted state, alarm-scheduled check-ins, realtime fan-out to dashboards, survives restarts |
| Agent Relay — Mac mini | caretaker / doctor / pharmacy / family agents message each other directly; the thread streams to the dashboard |
| "Bonus if both" | Actor = memory + scheduler, Relay = coordination. Each one does a job the other can't |
| Supabase "scale to millions" | Hospital records, call archive, care events. Postgres + RLS per family |
| Real-world pull | YC RFS fit (elder care, "$15/hour expert"). Get one caregiver or senior home on video saying they'd use it |

## Demo (the centerpiece): one person talks, the screen shows the context live

One screen, split view:
- **Left — the call:** a teammate (in a grandpa costume, for the costume contest) answers a real phone call from the voice agent, on speaker. The panel shows each tool call as it happens (med missed, symptom, teach-back). After hang-up a short call recap lands on the timeline. No raw transcript on screen (PRODUCT.md: summaries, not transcripts).
- **Right — the Care Feed:** three lanes, **Doctor / Pharmacy / Family**, fill in real time with what each one is about to receive. The agent-to-agent thread on Agent Relay is under them. The elder status card (ok / watch / urgent) and the next check-in countdown are on top.

Script (about 2 min):
1. Grandpa Joe is green. Next check-in in 15 s (the actor's alarm).
2. The alarm fires and the server places the call through ElevenLabs. Grandpa's phone rings, and he answers.
3. He says he is dizzy and ran out of his blood-pressure pills. On teach-back he gets his metformin timing wrong, and the agent gently corrects him.
4. While he talks, the Care Feed fills in. Doctor lane: a triage packet. Pharmacy lane: "refill ready 5 pm". Family lane: "Dad is OK but dizzy…". The agent thread shows them coordinating.
5. Status turns yellow. The actor schedules a recheck (countdown visible). When it fires, the phone rings again.
6. The durability flex: stop our server on stage (Ctrl-C) and start it again. Grandpa's state, his timeline and the pending recheck live in his ElderActor in Terse cloud, not in our server, so the dashboard reconnects with everything still there, and the recheck still rings his phone when it comes due. (With a local `terse actor dev` instead of the cloud actor: kill and restart the actor itself.)

## Scope

**In (MVP today):** phone check-in call (ElevenLabs agent on our Twilio number, dialed by the actor's alarm, tools as webhooks to `server/`) · browser voice call (OpenAI Realtime over WebRTC) kept as the fallback · medication teach-back · `ElderActor` (state, timeline, alarm, status) · care team on Agent Relay · split-view dashboard with live Care Feed · Supabase schema + seed hospital records + call archive · a scripted no-LLM demo mode as a safety net.

**Out (mocked or stretch):** Apple Watch / HealthKit → a "Simulate vitals spike" button · local-LLM webcam fall detection → stretch (one webcam frame to a vision model) · a live word-by-word transcript of the phone call → needs ElevenLabs' enterprise monitoring, so we show tool events live and a call recap after hang-up (the raw transcript is never shown) · real EHR / pharmacy → seed data · SMS to family → stretch (the MVP shows it in the Family lane).

## Architecture

```
[Grandpa's phone] ⇄ Twilio ⇄ [ElevenLabs agent: voice + teach-back prompt]
                                     │ webhook tools        ▲ outbound-call API
                                     ▼ (public tunnel)      │
web/ (Vite+React :5173) ──HTTP──▶ server/ (Bun :8787) ──Terse client──▶ actor/ ElderActor (:7100)
        ▲          WebSocket: state / state_update / call_due                 │ alarm → call_due
        └─────────────────────────────────────────────────────────────────────┘
server/ ──POST /escalate──▶ care-team/ (Bun :8788) ⇄ Agent Relay [caretaker · doctor · pharmacy · family]
                                  ├─ mirrors every relay message → ElderActor.logEvent (the live Care Feed)
                                  └─ reads hospital records ← Supabase (fallback: supabase/seed.json)
```

- **Call trigger:** actor alarm → `callState: "due"` → `server/` with `AUTO_DIAL=1` (it polls the actor and dials once) → ElevenLabs outbound call → Twilio → Grandpa's phone rings. `web/` never dials, so two open dashboards cannot ring the phone twice.
- **Network:** actor, server and care-team bind `127.0.0.1` only, and web is Vite on localhost, so nothing answers on the venue Wi-Fi. The tunnel reaches only `/api/el/*`: the server answers 403 to any other request that carries `x-forwarded-for`.
- **During the call:** the ElevenLabs agent calls its webhook tools → `server/` (`POST /api/el/tool/:name`) → the same tool code as before → `ElderActor` + `POST /escalate`. The Care Feed fills while he talks.
- **Fallback voice path (unchanged):** browser mic ⇄ WebRTC ⇄ OpenAI Realtime → `POST /api/tool`.

## Shared contract (every folder codes against this)

### Ports, env, secrets

| Service | Port | Env (real values only in git-ignored `.env`) |
|---|---|---|
| `actor/` (`terse actor dev`) | 7100 | `TERSE_ACTOR_URL`, `TERSE_API_KEY` (cloud only) |
| `server/` | 8787 | `OPENAI_API_KEY`, `CARE_TEAM_URL=http://localhost:8788`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (optional), `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID` (the ElevenLabs id of our Twilio number, `phnum_…`), `ELDER_PHONE` (the number to call), `EL_TOOL_SECRET` (shared secret the agent's webhook tools send) |
| `care-team/` | 8788 | `OPENAI_API_KEY`, `OPENAI_MODEL`, Agent Relay creds (see `care-team/README.md`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (optional) |
| `web/` | 5173 | `VITE_SERVER_URL=http://localhost:8787` |

Every folder ships a `.env.example`. **Never commit keys.** With no `OPENAI_API_KEY`, services run in mock mode with canned responses.

Demo elder id: **`grandpa-joe`**. Demo data source of truth: **`supabase/seed.json`**.

### `ElderActor` (`actor/src/actor.ts`)

```ts
type Status = "ok" | "watch" | "urgent"
type Med = { name: string; dose: string; times: string[]; purpose: string; lastTakenAt: number | null; missedCount: number }
type Profile = { name: string; age: number; conditions: string[]; family: { name: string; relation: string; phone?: string } }
type EventKind = "call_due" | "call_started" | "call_ended" | "med" | "symptom" | "teach_back" | "vitals" | "agent_msg" | "status" | "note"
type AgentName = "caretaker" | "doctor" | "pharmacy" | "family" | "family-contact"
type TimelineEvent = {
  id: string; ts: number; kind: EventKind; text: string
  from?: AgentName | "elder" | "system"; to?: AgentName
  data?: { lane?: "doctor" | "pharmacy" | "family"; urgency?: Status; [k: string]: unknown }
}
```

Emitted fields (`@Persisted @Emittable`): `profile: Profile | null`, `meds: Med[]`, `status: Status`, `statusReason: string`, `callState: "idle" | "due" | "in_progress"`, `nextCheckInAt: number | null`, `timeline: TimelineEvent[]` (newest last, capped at 200).

Methods (async, called through the generated client):
- `setup(profile: Profile, meds: Med[])`: full reset, used for the demo reset
- `scheduleCheckIn(atMs: number, reason?: string)`: sets `this.alarm` and `nextCheckInAt`
- `onAlarm()`: sets `callState = "due"`, adds a `call_due` timeline event, then `broadcast({ type: "call_due" })`. During a call (`callState === "in_progress"`) it rings nothing: it re-arms 60 s later and moves `nextCheckInAt`.
- `startCall()` / `endCall(summary: string, mood?: string)`
- `recordMed(name: string, taken: boolean, note?: string)`: updates `lastTakenAt` / `missedCount` and adds a `med` event
- `logEvent(e: { kind; text; from?; to?; data? }): TimelineEvent`
- `setStatus(status: Status, reason: string)`
- `getState()`: returns every emitted field

Rule: reassign arrays and objects instead of mutating them, or Terse will not persist the change.

### `server/` HTTP API (Bun, :8787, CORS for localhost)

- `GET  /api/realtime-token` → `{ value, expires_at?, model }`: an ephemeral OpenAI Realtime client secret. The real key never reaches the browser. Returns 503 `{ error, mock: true }` with no key.
- `GET  /api/actor-ws?elderId=` → `{ websocketUrl }` (from `actors.ElderActor.prepareWebsocket`)
- `GET  /api/state?elderId=` → `ElderActor.getState()`
- `POST /api/tool` `{ elderId, name, args }` → `{ output: string }`: runs the voice-agent tools listed below
- `POST /api/demo/reset` `{ elderId }`: `setup()` from `supabase/seed.json`
- `POST /api/demo/schedule` `{ elderId, inSeconds }`
- `POST /api/demo/vitals` `{ elderId, heartRate, note? }`: logs a `vitals` event, then escalates
- `POST /api/call/start` `{ elderId }` · `POST /api/call/end` `{ elderId, summary, mood? }`
- `POST /api/call/dial` `{ elderId }` → `{ conversationId, callSid }`: places the check-in call with ElevenLabs `POST /v1/convai/twilio/outbound-call` (`agent_id`, `agent_phone_number_id`, `to_number`), passing `elder_id`, `elder_first_name`, `elder_context` (profile, meds, status) and `greeting` in `conversation_initiation_client_data.dynamic_variables`, then calls `startCall()`. Dial once per `call_due`: the actor re-arms alarms after a restart. It dials only `ELDER_PHONE` from the server env, never a number from the request, and refuses while a call is dialing or in progress. Keep `ELDER_PHONE` out of logs, the timeline (it is broadcast and archived), dynamic variables and seed files.
- `POST /api/el/tool/:name` `{ ...tool args, elder_id? }` → `{ output }`: the ElevenLabs webhook tools. Rejects requests without the `x-unc-secret` header matching `EL_TOOL_SECRET` (the tunnel makes this route public), then runs the same tool code as `/api/tool`. `elder_id` defaults to `grandpa-joe`.
- `POST /api/el/post-call`: the ElevenLabs `post_call_transcription` webhook. Verify the `ElevenLabs-Signature` header, log `analysis.transcript_summary` to the timeline, end a call that is still open, and archive the transcript to Supabase `calls`.
- `POST /api/el/init` (header `x-unc-secret`): the conversation initiation webhook for **inbound** calls (the elder calls our number). ElevenLabs posts `{ caller_id, called_number, call_sid, conversation_id }` while the phone rings. The server starts the call on the actor ("Joe called Troska"), and answers with `{ type: "conversation_initiation_client_data", dynamic_variables: { elder_id, elder_first_name, elder_context, greeting } }`. Without these variables, ElevenLabs drops the call ("Missing required dynamic variables"). A number other than `ELDER_PHONE` still gets the demo elder, and the agent first confirms who it is talking to.

### Voice-agent tools (webhook tools on the ElevenLabs agent, plus `web/` for the browser fallback; executed by `server/`)

- `confirm_medication { med, taken, note? }` → `recordMed`
- `report_symptom { symptom, severity: "low"|"medium"|"high" }` → a `symptom` event. Medium or high also escalates.
- `teach_back_result { med, understood, note? }` → a `teach_back` event. If not understood, the family lane gets a note.
- `request_refill { med }` → escalates to the pharmacy
- `end_call { summary, mood }` → `endCall`, archives to Supabase, escalates the summary to the family

On the phone, the agent's built-in `end_call` hangs up after our `end_call` tool returns.

### ElevenLabs agent (the phone voice)

- The agent **"Troska check-in"** answers our Twilio number "HH" (inbound and outbound). `cd server && PUBLIC_URL=https://<tunnel> bun run el:setup` creates or updates all of it, and is safe to re-run after every tunnel restart:
  - the prompt and its five webhook tools
  - the stored `x-unc-secret` secret
  - the post-call webhook (its secret goes into `server/.env`)
  - the inbound-call webhook
  - the phone-number assignment
- Prompt: the check-in plus teach-back (`server/scripts/elevenlabs-agent.ts`). The elder's details arrive per call in `{{elder_context}}`. The first message is `{{greeting}}`, which depends on the call: "calling for your check-in", "calling back to check on you" (a recheck), or "Thanks for calling" (the elder called us).
- Tools: the five tools above as webhook tools → `https://<tunnel>/api/el/tool/<name>`. The closing-summary tool is named `save_call_summary`, because `end_call` is the built-in hang-up, which is also on.
- Webhooks: post-call → `https://<tunnel>/api/el/post-call`. Inbound calls → `https://<tunnel>/api/el/init`.
- Agent and phone-number ids go in `server/.env`, never in git. The tunnel is cloudflared or ngrok to `http://127.0.0.1:8787`; through it only `/api/el/*` answers (secret or signature checked), and everything else, including `/api/realtime-token` and `/api/call/dial`, gets 403.
- The meds in `{{elder_context}}` name each medicine first ("Amlodipine: 5 mg at 08:00"), and the prompt gives the current time and asks only about doses whose time has passed (as `buildInstructions()` does). The server also maps "Amlodipine 5 mg" to the listed med.

### `care-team/` (Bun, :8788): Agent Relay

- `POST /escalate` `{ elderId, kind: "symptom"|"refill"|"vitals"|"summary"|"teach_back", reason, details? }` → 202 · `GET /health`
- Four Agent Relay identities: `caretaker`, `doctor`, `pharmacy`, `family`. They use channel `care-<elderId>` and DMs. This must be real Agent Relay traffic, not an in-process bus.
- Flow: the caretaker posts the case. The doctor triages with the hospital record and replies `{ urgency, actions[] }`. The pharmacy confirms refills. The family agent drafts the message to the family contact. The doctor may ask for a recheck, and the care team then calls `scheduleCheckIn` and `setStatus` on the actor.
- **Every relay message is mirrored** to `ElderActor.logEvent({ kind: "agent_msg", from, to, text, data: { lane } })`. These events are the live Care Feed.

### Supabase (`supabase/`): only the team's Supabase owner applies changes to the remote project

Tables: `patients`, `prescriptions`, `clinical_notes`, `calls`, `care_events` (with RLS). `supabase/seed.sql` and `supabase/seed.json` hold the same data. Services fall back to the JSON when `SUPABASE_URL` is unset.

`seed.json` shape: `{ patients: [{ id, name, age, conditions[], family_name, family_relation, family_phone, primary_doctor }], prescriptions: [{ patient_id, name, dose, times[], purpose, prescriber, refills_left }], clinical_notes: [{ patient_id, author, note, created_at }] }`

## Team split (5 people)

| Role | Owns |
|---|---|
| P1 Actor | `actor/`: ElderActor, alarms, durability demo, `terse deploy` |
| P2 Voice | ElevenLabs agent (prompt, teach-back, webhook tools, dynamic variables) · `server/` ElevenLabs routes (`/api/call/dial`, `/api/el/tool/:name`) and the tunnel · `web/` OpenAI Realtime call kept as the fallback |
| P3 Agents | `care-team/`: Agent Relay wiring, doctor / pharmacy / family prompts, the safety floor, one case per call |
| P4 Dashboard + DB | `web/` Care Feed UI and the call panel ("Calling Grandpa…", live tool events, dial on `call_due`), `supabase/` schema and seed (the Supabase owner applies them to remote) |
| P5 Pitch | demo script, backup video, slides, grandpa costume, real-world validation clip, Builderbase submission |

## Timeline (today)

- 11:30 contract locked (this file), scaffolds up
- 13:00 lunch; each piece runs on its own
- 14:30 end-to-end path works (call → Care Feed → recheck). If the phone path doesn't work end to end by then, the live demo uses the browser call, and the backup video shows the phone call.
- 15:15 feature freeze, rehearse, record the backup demo video
- 15:45 submit on Builderbase (deadline 16:00)

## Pitch hooks

- "A care team that never forgets": one durable actor per elder.
- "The agents talk to each other, so the family doesn't have to play telephone."
- Safety: no diagnosis. The doctor agent triages and escalates to humans.
- "Grandpa's own phone rings. There's no app to install."

## Decisions

- **13:20 Phone call through ElevenLabs.** The team tested an ElevenLabs agent calling out from our Twilio number, and it works. It replaces OpenAI Realtime as the main voice layer, and that's all it replaces. The actor (alarm, memory) and the care team on Agent Relay stay as they are; they are the two prize stories. We don't use ElevenLabs agent transfers for the doctor or pharmacy, because that would duplicate Agent Relay. The browser OpenAI Realtime call stays as the fallback.
- **13:20 One care-team.** The `care-team/` on this branch ships. Mian adds two things from `mian/ych-3-care-team`, which stays as a reference and is not merged:
  - **A safety floor:** danger signs (chest pain, fainting, a fall, slurred speech, heart rate ≥130 or ≤40, severity high) are always urgent. The LLM can raise urgency but never lower it.
  - **One case per call:** escalations for an elder within 3 minutes join the open case, so one call makes one thread and each medication is refilled once. (Done: `e2e.ts` checks one case per call, and every care-team message carries `data.trigger`.)
- **13:55 Transcript.** No raw transcript on screen, on either voice path: the call panel lists what Troska heard (tool events), and the phone call adds a short recap after hang-up. The full transcript only goes to the Supabase archive.
- **13:55 Symptom cases carry the call's missed meds.** `report_symptom` adds `details.missedMeds` (e.g. "Amlodipine: not taken (Ran out two days ago)"), and the call covers meds before symptoms, so the doctor can link the dizziness to the missed pill and order the refill itself (the doctor → pharmacy hop on Agent Relay).
- **14:05 Supabase is the system of record.** The schema and seed are applied to the team project (`supabase/apply.ts`, over the IPv4 pooler).
  - The demo reset and the doctor read the hospital record from it.
  - `calls` stores every call, with `started_at`, summary, mood and transcript.
  - `care_events` stores every tool event, every Agent Relay message and every call ending.
  - Tests never touch it.
- **14:15 The ElderActor runs in Terse cloud** (org "unc", project `unc-actor`). The CLI has no local runtime for Windows, and the cloud lets any laptop run the demo. Callers set `TERSE_ACTOR_URL` and `TERSE_API_KEY`. The durability flex (Demo, step 6) restarts our server, because the state lives in the actor.
- **14:26 First real phone call.** It worked end to end, and it showed that a mid-call urgent recheck could ring the phone again. That is now blocked in both the actor and the server.
- **14:45 The elder can call Troska.** Inbound calls to the number were dropped ("Missing required dynamic variables"). Now `/api/el/init` answers them with the elder's details (see `server/` API).
- **15:25 A recap text after every call.** From the post-call webhook, `server/src/sms.ts` texts the person on the call from our Twilio number: the summary in plain second person (rewritten by OpenAI), plus the next check-in time. It sends once per conversation, and logs "Texted Joe…" or Twilio's refusal on the timeline. It needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`. US long-code texts need A2P 10DLC registration.
- **15:05 Caller profiles: a phone number is a person.** Before this, every inbound caller was treated as Grandpa Joe.
  - Every call, in or out, finds its person in Supabase by phone number (`patients.phone`, migration `20261031150000_caller_profiles.sql`).
  - A number we haven't met gets a new profile (`caller-<digits>`). The agent asks who they are, and saves it with the new `save_profile` tool.
  - The agent's context carries the person's last 3 calls and recent symptoms from Supabase, so it remembers them across calls, numbers and restarts.
  - Outbound calls ring the number on the profile.
  - Safety: an overdose is now a danger sign, and the prompt makes the agent log an emergency (`report_symptom`, high) *before* telling the caller to dial 911. A real test call had shown the agent skipping the log.
- **14:50 Renamed Unc → Troska** in every user-facing place: the voice agent, greetings, family texts, the web app and the docs. Internal identifiers keep their names, because renaming them would break the live setup for no visible gain: the `x-unc-secret` and `x-unc-key` headers, the `unc-*` package names and the Terse project `unc-actor`.
