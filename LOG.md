# Build log — Unc (Haunted Hacks, Oct 31 2026)

A running log of what was done, newest at the bottom. Times are PT. Add your own lines as you go.

## Mian — care-team/ (YCH-3, Agent Relay)

- **12:37** YCH-3 assigned to Mian and moved to In Progress.
- **12:38** Read the real Agent Relay SDK (`@agent-relay/sdk` 15.0.1) and `terse-cli` 0.14.9 from npm. Findings that shaped the design:
  - Agent registration is create-only, and a restart hits `name_conflict` (409). So agent tokens are saved to `care-team/.relay-agents.json` (git-ignored), and restarts reconnect with them.
  - With four agents in one process, the listener can deliver the same message more than once, so care-team skips repeats by message id.
  - The hosted relay is `cast.agentrelay.com`. The generated Terse client reads `TERSE_ACTOR_URL` / `TERSE_API_KEY` and defaults to local :7100.
- **12:40** Started `care-team/` on top of `feat/unc-plan-and-scaffold`, following the PLAN.md contract: `POST /escalate` returns 202, plus `GET /health`.
- **12:44** First end-to-end run of the demo storyline, using the in-process relay and the console actor. All three lanes fill: triage packet → WATCH triage → status + 90 s recheck → "refill ready 5 pm" → texts to Linda.
- **12:46** Fixed two bugs: the teach-back and summary texts to Linda repeated the triage text, and the pharmacy text said "1 refills". Added a test for each.
- **12:48** `bun test`: 8 pass (storyline, duplicate delivery, missing metadata, urgent vitals, LLM safety floor, LLM failure fallback, HTTP). `tsc --noEmit` is clean.
- **12:50** Committed `care-team/`. The push to GitHub is waiting on repo access for the push tool. The OpenAI key lives only in the local `care-team/.env`, which git ignores.
- **12:51** Linear: posted the care-team status and lane rule on YCH-3, the `/escalate` details and `/demo/storyline` on YCH-6 (server), and the seed names on YCH-5 (DB).
- **12:58** Decision: care-team goes on its own branch, `mian/ych-3-care-team` (based on `feat/unc-plan-and-scaffold`), committed as Mian. Other people's branches stay untouched; merging is the team's call.

### Open / needs
- [ ] Agent Relay workspace key (`npx -y agent-relay@next init --hosted`) goes in `care-team/.env`, then run `bun run smoke:relay`.
- [ ] Once `actor/` runs: `terse actor generate` inside `care-team/`, then confirm the `actors.ElderActor.get(id)` accessor.
- [ ] Agree seed names with Vi (Joe Miller, lisinopril, metformin, Dr. Patel, daughter Linda).
- [ ] Server: send `POST /escalate` with the `details` listed in `care-team/README.md`.
