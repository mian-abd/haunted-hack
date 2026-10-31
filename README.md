# Unc: an AI care team for aging parents

A voice agent makes check-in calls to an elder: it confirms medications, runs teach-back and notices when something is off.
Behind the call, doctor, pharmacy and family agents work the case with each other over Agent Relay, and one durable actor per elder remembers everything and schedules the next call.

Built at Haunted Hacks (Oct 31, 2026) with Terse Durable Actors, Agent Relay, OpenAI Realtime and Supabase. All people and medical data in this repo are fictional.

## Prerequisites

- [Bun](https://bun.sh) 1.4.2 or newer
- The Terse CLI: `bunx terse-cli@latest install --yes` (installs to `~/.bun/bin/terse`)
- Chrome or another WebRTC browser with a microphone, for the live voice call
- An OpenAI API key (optional: without one, voice is offline, the agents use canned replies, and the scripted demo still runs)

## Quickstart

```sh
cp .env.example .env    # then set OPENAI_API_KEY in .env
./dev.sh                # starts actor :7100, server :8787, care-team :8788 and web :5173, prefixed logs, Ctrl-C stops all
```

Open http://localhost:5173 when dev.sh prints the `[dev] ready` line. On a fresh clone, dev.sh runs `bun install` in `actor/` and `web/` first.

Check the whole system end to end (real actor, real OpenAI brains, real Agent Relay traffic) while dev.sh runs:

```sh
bun e2e.ts              # PASS/FAIL per step with latency per hop; exits 1 on any FAIL
```

## Demo flow

The 2-minute script is in [PLAN.md, Demo](PLAN.md#demo-the-centerpiece-one-person-talks-the-screen-shows-the-context-live). In short: Reset demo, Check-in in 15 s, answer the call, Grandpa says he is dizzy and out of his blood-pressure pills, the Care Feed fills with the doctor, pharmacy and family agents' messages, his status turns to watch with a recheck scheduled, then restart the actor and show that the state and the alarm survive.

## Architecture

```
[Grandpa: browser mic] ⇄ WebRTC ⇄ [OpenAI Realtime voice agent]
        │ tool calls (data channel)
        ▼
web/ (Vite+React :5173) ──HTTP──▶ server/ (Bun :8787) ──Terse client──▶ actor/ ElderActor (:7100)
        ▲          WebSocket: state / state_update / call_due                 │ alarm → call_due
        └─────────────────────────────────────────────────────────────────────┘
server/ ──POST /escalate──▶ care-team/ (Bun :8788) ⇄ Agent Relay [caretaker · doctor · pharmacy · family]
                                  ├─ mirrors every relay message → ElderActor.logEvent (the live Care Feed)
                                  └─ reads hospital records ← Supabase (fallback: supabase/seed.json)
```

| Folder | What it is |
|---|---|
| [actor/](actor/README.md) | `ElderActor`, the Terse durable actor: state, timeline, alarm-scheduled check-ins, live WebSocket fan-out |
| [server/](server/README.md) | Bun HTTP API: Realtime voice keys, the voice agent's tools, demo endpoints, Supabase call archive |
| [care-team/](care-team/README.md) | The caretaker, doctor, pharmacy and family agents on Agent Relay |
| [web/](web/README.md) | The demo screen: the call panel and the live Care Feed |
| [supabase/](supabase/README.md) | Postgres schema with RLS, fictional seed records |

The shared contract between the folders is [PLAN.md](PLAN.md).

## Troubleshooting

- **A port is busy.** dev.sh stops if 7100, 8787, 8788 or 5173 is taken. Find the process with `lsof -iTCP:8787 -sTCP:LISTEN`. Web must stay on 5173, because the server only allows CORS from there.
- **Voice fails or there is no key.** The call panel shows "Voice offline". Use **Run scripted demo**: it plays the same storyline with real tool calls, so the actor and the care team still react for real (labeled "scripted"). `http://localhost:5173/?mock=1` renders a fixture with no server at all. Add `?debug` to the URL to log every Realtime event in the browser console.
- **Agent Relay.** With no `RELAY_WORKSPACE_KEY`, each care-team start creates a fresh anonymous 24-hour workspace, so the relay history starts empty after a restart (the actor timeline keeps it). Set `RELAY_WORKSPACE_KEY` to keep one workspace (see [care-team/README.md](care-team/README.md)). `RELAY_MODE=local` is an offline fallback that does not use Agent Relay. `curl localhost:8788/health` shows the relay mode, the model and how many OpenAI calls fell back to canned replies.
- **The durability flex.** While dev.sh runs, stop only the actor with `pkill -INT -f "terse actor dev"` (server, care-team and web keep running), then start it again in a second terminal: `cd actor && ~/.bun/bin/terse actor dev`. The dashboard reconnects with a fresh grant, and the state and a pending check-in alarm survive. The local runtime re-arms the alarm when something wakes the actor (see [actor/README.md](actor/README.md)). An actor started that way is outside dev.sh, so stop it with Ctrl-C in its own terminal.
- **Slow or odd agent messages.** Defaults are `OPENAI_MODEL=gpt-6-luna` and `OPENAI_REASONING_EFFORT=none`. `bun e2e.ts` prints the latency of every hop.
