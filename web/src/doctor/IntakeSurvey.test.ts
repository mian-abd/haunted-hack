import { expect, test } from "bun:test"
import { buildNote } from "./IntakeSurvey"

const base = {
  name: "Joe", dob: "", language: "", senses: "", callTime: "", conditions: ["Diabetes"], otherCondition: "gout",
  history: "", allergies: "penicillin, rash", mobility: "Walks with a cane", memory: "",
  meds: [{ name: "Metformin", dose: "500 mg", times: "8am", purpose: "diabetes" }], pharmacy: "", organizer: "",
  doctor: "", specialists: "", contacts: [{ name: "Anna", relation: "daughter", reach: "555-0100" }], emergency: "",
  alwaysTell: "", avoid: "", consent: true,
}

test("note has headings and answered fields only", () => {
  const n = buildNote(base, "Intake survey")
  expect(n).toContain("ABOUT YOUR PARENT\nPreferred name: Joe")
  expect(n).toContain("Conditions: Diabetes, Other: gout")
  expect(n).toContain("- Metformin, 500 mg, taken 8am, for diabetes")
  expect(n).toContain("- Anna (daughter): 555-0100")
  expect(n).not.toContain("Date of birth")
})

test("note stays within 4000 chars", () => {
  const long = "x".repeat(5000)
  const meds = Array.from({ length: 60 }, () => ({ name: long, dose: long, times: long, purpose: long }))
  expect(buildNote({ ...base, history: long, allergies: long, alwaysTell: long, meds }, "A").length).toBeLessThanOrEqual(4000)
})
