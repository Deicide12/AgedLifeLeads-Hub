import { validate, bellMessage } from "../lib/win.mjs";
import { rpc, missingEnv } from "../lib/supabase.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const missing = missingEnv();
  if (missing.length) return res.status(503).json({ error: "Not configured.", missing });
  const { DISCORD_WEBHOOK_URL } = process.env;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const check = validate(body);
  if (!check.ok) return res.status(400).json({ errors: check.errors });
  const win = check.value;

  let out;
  try {
    out = await rpc("submit_win", { p: win });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Couldn't save — please try again." });
  }
  if (out.error === "rate_limited") {
    return res.status(429).json({ error: "Too many submissions — try again in a few minutes." });
  }

  if (out.status === "public" && DISCORD_WEBHOOK_URL) {
    const content = bellMessage({
      name: win.submitter_name,
      showName: win.show_name,
      leadType: win.lead_type,
      apCents: win.annual_premium_cents,
    });
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(3000),
    }).catch((e) => console.error("discord", e));
  }

  return res.status(200).json({ status: out.status });
}
