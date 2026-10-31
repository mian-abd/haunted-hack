// Applies the schema and the demo seed to a Postgres database: the remote Supabase project, or a local one.
//   SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres bun supabase/apply.ts
// Same effect as pasting both files into the SQL editor (README "Apply to the remote project"). Both are safe to re-run.
// The connection string holds the database password: pass it in the shell, never commit it.
import { SQL } from "bun"

const url = process.env.SUPABASE_DB_URL?.trim()
if (!url) {
  console.error("Set SUPABASE_DB_URL (Supabase dashboard → Connect → connection string).")
  process.exit(1)
}

const db = new SQL(url)
try {
  for (const file of ["migrations/20261031120000_init.sql", "seed.sql"]) {
    await db.unsafe(await Bun.file(new URL(file, import.meta.url)).text()).simple()
    console.log(`applied ${file}`)
  }
  const [n] = await db`select
    (select count(*) from public.patients)::int as patients,
    (select count(*) from public.prescriptions)::int as prescriptions,
    (select count(*) from public.clinical_notes)::int as clinical_notes,
    (select count(*) from public.calls)::int as calls,
    (select count(*) from public.care_events)::int as care_events`
  console.log(n)
} finally {
  await db.close()
}
