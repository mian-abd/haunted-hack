// Checks supabase/seed.json against the PLAN.md shape, and that every row is also in seed.sql.
// Run from the repo root: bun supabase/check-seed.ts
type Row = Record<string, unknown>;
const seed: Record<string, Row[]> = await Bun.file(`${import.meta.dir}/seed.json`).json();
const sqlLines = (await Bun.file(`${import.meta.dir}/seed.sql`).text()).split("\n");

// The "seed.json shape" in PLAN.md. int = whole number, string[] = array of strings.
const shape: Record<string, Record<string, string>> = {
  patients: { id: "string", name: "string", age: "int", conditions: "string[]", family_name: "string", family_relation: "string", family_phone: "string", primary_doctor: "string" },
  prescriptions: { patient_id: "string", name: "string", dose: "string", times: "string[]", purpose: "string", prescriber: "string", refills_left: "int" },
  clinical_notes: { patient_id: "string", author: "string", note: "string", created_at: "string" },
};

const errors: string[] = [];
const check = (ok: boolean, msg: string) => ok || errors.push(msg);
const typeOf = (v: unknown) =>
  Array.isArray(v) ? (v.every((x) => typeof x === "string") ? "string[]" : "array") : Number.isInteger(v) ? "int" : typeof v;
// A string must appear as a quoted SQL literal; a number as a whole value between ( , and , ) so that 0 does not match '08:00'.
const inLine = (line: string, v: unknown) =>
  typeof v === "string" ? line.includes(`'${v.replaceAll("'", "''")}'`) : new RegExp(`[(,]\\s*${v}\\s*[,)]`).test(line);
const sameKeys = (a: object, b: object) => Object.keys(a).sort().join() === Object.keys(b).sort().join();

check(sameKeys(seed, shape), `top-level keys must be ${Object.keys(shape)}, got ${Object.keys(seed)}`);
for (const [table, fields] of Object.entries(shape)) {
  const rows = seed[table] ?? [];
  check(rows.length > 0, `${table} is empty`);
  rows.forEach((row, i) => {
    check(sameKeys(row, fields), `${table}[${i}] keys must be ${Object.keys(fields)}, got ${Object.keys(row)}`);
    for (const [k, t] of Object.entries(fields)) check(typeOf(row[k]) === t, `${table}[${i}].${k} must be ${t}, got ${typeOf(row[k])}`);
    // seed.sql keeps one row per line, so one line must hold every value of this row.
    const values = Object.values(row).flat();
    check(sqlLines.some((line) => values.every((v) => inLine(line, v))), `${table}[${i}] is not in seed.sql: ${JSON.stringify(row)}`);
  });
}

const ids = new Set((seed.patients ?? []).map((p) => p.id));
check(ids.has("grandpa-joe"), "the demo elder grandpa-joe is missing");
// The repo is public: only fictional 555-01xx numbers.
for (const p of seed.patients ?? []) check(/^\+1-555-01\d\d$/.test(String(p.family_phone)), `${p.id}: family_phone must look like +1-555-01xx`);
for (const r of [...(seed.prescriptions ?? []), ...(seed.clinical_notes ?? [])]) check(ids.has(r.patient_id), `unknown patient_id ${r.patient_id}`);
for (const n of seed.clinical_notes ?? []) check(!Number.isNaN(Date.parse(String(n.created_at))), `bad created_at ${n.created_at}`);

if (errors.length) {
  console.error(`check-seed: ${errors.length} problem(s)\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`check-seed: ok (${seed.patients.length} patients, ${seed.prescriptions.length} prescriptions, ${seed.clinical_notes.length} clinical notes, all in seed.sql)`);
