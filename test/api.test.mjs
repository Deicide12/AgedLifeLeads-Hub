import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import submitWin from "../api/submit-win.mjs";
import wins from "../api/wins.mjs";

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
}

let calls;
function stubFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, fn] of routes) if (String(url).includes(match)) return fn();
    throw new Error("unexpected fetch " + url);
  };
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const body = {
  submitter_email: "mike@example.com",
  submitter_name: "Mike Ross",
  client_name: "Jane Doe",
  client_phone: "5551234567",
  lead_type: "Final Expense",
  premium: "1200",
  premium_mode: "annual",
};

beforeEach(() => {
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.DISCORD_WEBHOOK_URL = "https://discord.test/hook";
});

test("submit-win: 405 on GET", async () => {
  const res = mockRes();
  await submitWin({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
});

test("submit-win: 503 when not configured", async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body.missing, ["SUPABASE_SERVICE_ROLE_KEY"]);
});

test("submit-win: 400 with field errors and no DB call", async () => {
  stubFetch([]);
  const res = mockRes();
  await submitWin({ method: "POST", body: { ...body, submitter_email: "bad" } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.submitter_email);
  assert.equal(calls.length, 0);
});

test("submit-win: saves via RPC and rings Discord without mentions", async () => {
  stubFetch([
    ["/rest/v1/rpc/submit_win", () => json({ id: "w1", status: "public" })],
    ["discord.test", () => new Response(null, { status: 204 })],
  ]);
  const res = mockRes();
  await submitWin({ method: "POST", body: JSON.stringify(body) }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: "public" });
  assert.equal(calls[0].init.headers.Authorization, "Bearer service-key");
  assert.equal(JSON.parse(calls[0].init.body).p.client_phone, "5551234567");
  const discord = JSON.parse(calls[1].init.body);
  assert.equal(discord.content, "🔔 Mike R. just closed a Final Expense deal — $1,200 AP!");
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
});

test("submit-win: no Discord URL -> saves without ringing", async () => {
  delete process.env.DISCORD_WEBHOOK_URL;
  stubFetch([["/rest/v1/rpc/submit_win", () => json({ id: "w2", status: "public" })]]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
});

test("submit-win: Discord failure still returns 200", async () => {
  stubFetch([
    ["/rest/v1/rpc/submit_win", () => json({ id: "w3", status: "public" })],
    ["discord.test", () => { throw new Error("down"); }],
  ]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 200);
});

test("submit-win: rate limited -> 429", async () => {
  stubFetch([["/rest/v1/rpc/submit_win", () => json({ error: "rate_limited" })]]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 429);
});

test("submit-win: DB error -> 500", async () => {
  stubFetch([["/rest/v1/rpc/submit_win", () => json({ message: "boom" }, 500)]]);
  const res = mockRes();
  await submitWin({ method: "POST", body }, res);
  assert.equal(res.statusCode, 500);
});

test("wins: only public-safe fields, cached", async () => {
  stubFetch([["/rest/v1/rpc/wins_board", () => json({
    leaderboard: [{ name: "Mike Ross", show_name: true, ap_cents: 120000, wins: 1, submitter_email: "leak@x.com" }],
    feed: [],
  })]]);
  const res = mockRes();
  await wins({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { leaderboard: [{ name: "Mike R.", ap_cents: 120000, wins: 1 }], feed: [] });
  assert.match(res.headers["cache-control"], /s-maxage=30/);
});

test("wins: DB error -> 502", async () => {
  stubFetch([["/rest/v1/rpc/wins_board", () => json({}, 500)]]);
  const res = mockRes();
  await wins({ method: "GET" }, res);
  assert.equal(res.statusCode, 502);
});
