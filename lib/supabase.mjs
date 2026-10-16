// Server-only: calls a Postgres function through PostgREST with the service-role key.
export async function rpc(name, args = {}) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${name} ${r.status}: ${await r.text()}`);
  return r.json();
}
