// Environment for care-team/. Bun loads care-team/.env automatically when started from this folder.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : fallback
}

export interface Config {
  port: number
  openaiApiKey: string | null
  openaiModel: string
  openaiTimeoutMs: number
  relayWorkspaceKey: string | null
  relayBaseUrl: string | null
  relayTokenFile: string
  actorMode: "auto" | "terse" | "console"
  supabaseUrl: string | null
  supabaseKey: string | null
  seedPath: string
  recheckSeconds: number
  urgentRecheckSeconds: number
  stepDelayMs: number
  caseWindowMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const actorMode = (env.ACTOR_MODE ?? "auto") as Config["actorMode"]
  return {
    port: num("PORT", 8788),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    openaiTimeoutMs: num("OPENAI_TIMEOUT_MS", 8000),
    relayWorkspaceKey: env.RELAY_WORKSPACE_KEY?.trim() || null,
    relayBaseUrl: env.RELAY_BASE_URL?.trim() || null,
    relayTokenFile: env.RELAY_TOKEN_FILE?.trim() || ".relay-agents.json",
    actorMode: ["auto", "terse", "console"].includes(actorMode) ? actorMode : "auto",
    supabaseUrl: env.SUPABASE_URL?.trim() || null,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null,
    seedPath: env.SEED_PATH?.trim() || "../supabase/seed.json",
    recheckSeconds: num("DEMO_RECHECK_SECONDS", 90),
    urgentRecheckSeconds: num("URGENT_RECHECK_SECONDS", 60),
    stepDelayMs: num("STEP_DELAY_MS", 1200),
    caseWindowMs: num("CASE_WINDOW_MS", 180_000),
  }
}

export const channelFor = (elderId: string) => `care-${elderId}`
