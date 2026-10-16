import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, normalizePhone, toAnnualCents, displayName, bellMessage, toPublicBoard } from "../lib/win.mjs";

const good = {
  submitter_email: " Mike@Example.com ",
  submitter_name: "Mike Ross",
  client_name: "Jane Doe",
  client_phone: "(555) 123-4567",
  lead_type: "Final Expense",
  premium: "100",
  premium_mode: "monthly",
  show_name: true,
};

test("validate: happy path normalizes values", () => {
  const r = validate(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.submitter_email, "mike@example.com");
  assert.equal(r.value.client_phone, "5551234567");
  assert.equal(r.value.annual_premium_cents, 120000);
  assert.equal(r.value.premium_mode, "monthly");
  assert.equal(r.value.client_email, null);
  assert.equal(r.value.submitter_phone, null);
  assert.equal(r.value.show_name, true);
});

test("validate: rejects each bad field", () => {
  const cases = [
    [{ submitter_email: "nope" }, "submitter_email"],
    [{ submitter_name: " " }, "submitter_name"],
    [{ client_name: "" }, "client_name"],
    [{ client_phone: "123" }, "client_phone"],
    [{ client_phone: "", client_email: "" }, "client_phone"],
    [{ client_phone: "", client_email: "bad@" }, "client_email"],
    [{ lead_type: "Health" }, "lead_type"],
    [{ premium: "0" }, "premium"],
    [{ premium: "abc" }, "premium"],
    [{ premium: "9000", premium_mode: "monthly" }, "premium"], // $108k AP > cap
  ];
  for (const [patch, field] of cases) {
    const r = validate({ ...good, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors[field], `${field} for ${JSON.stringify(patch)}`);
  }
});

test("validate: honeypot and non-object bodies are rejected", () => {
  assert.equal(validate({ ...good, website: "http://spam" }).ok, false);
  assert.equal(validate(null).ok, false);
});

test("validate: client email alone is enough", () => {
  const r = validate({ ...good, client_phone: "", client_email: "JANE@x.com" });
  assert.equal(r.ok, true);
  assert.equal(r.value.client_email, "jane@x.com");
  assert.equal(r.value.client_phone, null);
});

test("validate: show_name defaults on, only false turns it off", () => {
  const { show_name, ...rest } = good;
  assert.equal(validate(rest).value.show_name, true);
  assert.equal(validate({ ...good, show_name: false }).value.show_name, false);
});

test("normalizePhone", () => {
  assert.equal(normalizePhone("555-123-4567"), "5551234567");
  assert.equal(normalizePhone("+1 (555) 123-4567"), "5551234567");
  assert.equal(normalizePhone("15551234567"), "5551234567");
  assert.equal(normalizePhone("25551234567"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(undefined), null);
});

test("toAnnualCents", () => {
  assert.equal(toAnnualCents("1200", "annual"), 120000);
  assert.equal(toAnnualCents("49.99", "monthly"), 59988);
  assert.ok(Number.isNaN(toAnnualCents("x", "annual")));
});

test("displayName", () => {
  assert.equal(displayName("Mike Ross", true), "Mike R.");
  assert.equal(displayName("  mary ann smith ", true), "mary S.");
  assert.equal(displayName("Cher", true), "Cher");
  assert.equal(displayName("Mike Ross", false), "An agent");
  assert.equal(displayName("", true), "An agent");
});

test("bellMessage", () => {
  assert.equal(
    bellMessage({ name: "Mike Ross", showName: true, state: "TX", leadType: "Final Expense", apCents: 120000 }),
    "🔔 Mike R. (TX) just closed a Final Expense deal — $1,200 AP!"
  );
  assert.equal(
    bellMessage({ name: "Mike Ross", showName: false, state: null, leadType: "IUL", apCents: 99950 }),
    "🔔 An agent just closed an IUL deal — $1,000 AP!"
  );
});

test("toPublicBoard keeps only safe fields", () => {
  const out = toPublicBoard({
    leaderboard: [{ name: "Mike Ross", show_name: true, ap_cents: "240000", wins: 2, submitter_email: "x@y.com" }],
    feed: [{ name: "Jane Roe", show_name: false, state: "", lead_type: "IUL", ap_cents: 5000, created_at: "2026-10-17T00:00:00Z", client_phone: "5551234567" }],
  });
  assert.deepEqual(out, {
    leaderboard: [{ name: "Mike R.", ap_cents: 240000, wins: 2 }],
    feed: [{ name: "An agent", state: null, lead_type: "IUL", ap_cents: 5000, created_at: "2026-10-17T00:00:00Z" }],
  });
  assert.deepEqual(toPublicBoard(null), { leaderboard: [], feed: [] });
});
