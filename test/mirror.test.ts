import assert from "node:assert/strict";
import { test } from "node:test";
import { planRow } from "../src/import/mirror.ts";

const index = { company: 0, status: 1, fit: 2, closes: 3, next: 4 };

test("on my own rows: status moves, my writing and empty values are left alone", () => {
  const seen = { company: "Temporal", status: "Ready to apply", fit: "My fit read", closes: "Not stated", next: "Call scheduled" };
  const current = ["Temporal", "Ready to apply", "My fit read", "Not stated", "Call scheduled"];
  const want = { company: "Temporal", status: "Interviewing", fit: "A generated fit read", closes: "", next: "Something else" };
  const { writes } = planRow(index, current, seen, want, false);
  assert.deepEqual(writes, [{ col: 1, value: "Interviewing" }]);
});

test("a cell I changed since the tool last looked is never overwritten", () => {
  const seen = { company: "Acme", status: "Ready to apply", fit: "x", closes: "", next: "" };
  const current = ["Acme", "Applied (via referral)", "x", "", ""];
  const { writes, next } = planRow(index, current, seen, { ...seen, status: "Applied" }, true);
  assert.deepEqual(writes, []);
  assert.equal(next.status, "Applied (via referral)");
});

test("on rows the tool added, a rebuilt pack refreshes any column it still owns", () => {
  const seen = { company: "Acme", status: "Ready to apply", fit: "Old read", closes: "", next: "Apply" };
  const current = ["Acme", "Ready to apply", "Old read", "", "Apply"];
  const { writes } = planRow(index, current, seen, { ...seen, fit: "New read", closes: "10 Dec 2026" }, true);
  assert.deepEqual(writes, [{ col: 2, value: "New read" }, { col: 3, value: "10 Dec 2026" }]);
});

test("empty cells on my rows get filled", () => {
  const seen = { company: "Acme", status: "Applied", fit: "", closes: "", next: "" };
  const current = ["Acme", "Applied", "", "", ""];
  const { writes } = planRow(index, current, seen, { ...seen, closes: "5 Dec 2026" }, false);
  assert.deepEqual(writes, [{ col: 3, value: "5 Dec 2026" }]);
});

test("my own wording for the same status or date is kept", () => {
  const idx = { status: 0, applied: 1 };
  const seen = { status: "Check if still open", applied: "23 Nov 2026 (WhatsApp)" };
  const { writes } = planRow(idx, ["Check if still open", "23 Nov 2026 (WhatsApp)"], seen, { status: "Ask before applying", applied: "23 Nov 2026" }, false);
  assert.deepEqual(writes, []);
});
