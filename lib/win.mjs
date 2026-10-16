// Pure helpers shared by the API and index.html. Keep browser-safe: no Node APIs, no secrets.

export const LEAD_TYPES = [
  "Final Expense",
  "Semi-Fresh Final Expense",
  "IUL",
  "Mortgage Protection",
  "Veteran Protection",
  "OTP-Verified Final Expense (FEX)",
  "OTP-Verified Indexed Universal Life (IUL)",
  "OTP-Verified Mortgage Protection (MTG)",
  "OTP-Verified Veteran Protection (VET)",
  "OTP-Verified Semi-Fresh Veteran Protection",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_AP_CENTS = 100;
const MAX_AP_CENTS = 10_000_000;

const str = (v, max) => String(v ?? "").trim().slice(0, max);

export function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return d.length === 10 ? d : null;
}

export function toAnnualCents(amount, mode) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * (mode === "monthly" ? 12 : 1) * 100);
}

export function displayName(name, showName) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!showName || !parts.length) return "An agent";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`;
}

export function formatAP(cents) {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

export function bellMessage({ name, showName, leadType, apCents }) {
  const article = /^[aeiou]/i.test(leadType) ? "an" : "a";
  return `🔔 ${displayName(name, showName)} just closed ${article} ${leadType} deal — ${formatAP(apCents)} AP!`;
}

export function validate(body) {
  const b = body && typeof body === "object" ? body : null;
  if (!b || str(b.website, 200)) return { ok: false, errors: { form: "Submission rejected." } };

  const mode = b.premium_mode === "monthly" ? "monthly" : "annual";
  const rawClientPhone = str(b.client_phone, 30);
  const value = {
    submitter_email: str(b.submitter_email, 200).toLowerCase(),
    submitter_name: str(b.submitter_name, 100),
    submitter_phone: str(b.submitter_phone, 30) || null,
    client_name: str(b.client_name, 100),
    client_phone: rawClientPhone ? normalizePhone(rawClientPhone) : null,
    client_email: str(b.client_email, 200).toLowerCase() || null,
    lead_type: str(b.lead_type, 100),
    carrier: str(b.carrier, 100) || null,
    premium_mode: mode,
    annual_premium_cents: toAnnualCents(b.premium, mode),
    testimonial: str(b.testimonial, 500) || null,
    show_name: b.show_name !== false,
  };

  const errors = {};
  if (!EMAIL.test(value.submitter_email)) errors.submitter_email = "Enter a valid email.";
  if (!value.submitter_name) errors.submitter_name = "Enter your name.";
  if (!value.client_name) errors.client_name = "Enter the client's name.";
  if (rawClientPhone && !value.client_phone) errors.client_phone = "Enter a 10-digit phone number.";
  if (!rawClientPhone && !value.client_email) errors.client_phone = "Enter the client's phone or email.";
  if (value.client_email && !EMAIL.test(value.client_email)) errors.client_email = "Enter a valid email.";
  if (!LEAD_TYPES.includes(value.lead_type)) errors.lead_type = "Pick a lead type.";
  const ap = value.annual_premium_cents;
  if (!(ap >= MIN_AP_CENTS && ap <= MAX_AP_CENTS)) errors.premium = "Annual premium must be $1–$100,000.";

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

// Whitelists public-safe fields from the wins_board() RPC result.
export function toPublicBoard(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    leaderboard: (r.leaderboard ?? []).map((x) => ({
      name: displayName(x.name, x.show_name),
      ap_cents: Number(x.ap_cents),
      wins: Number(x.wins),
    })),
    feed: (r.feed ?? []).map((x) => ({
      name: displayName(x.name, x.show_name),
      lead_type: x.lead_type,
      ap_cents: Number(x.ap_cents),
      created_at: x.created_at,
    })),
  };
}
