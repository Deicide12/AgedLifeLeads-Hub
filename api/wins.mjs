import { toPublicBoard } from "../lib/win.mjs";
import { rpc, missingEnv } from "../lib/supabase.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const missing = missingEnv();
  if (missing.length) return res.status(503).json({ error: "Not configured.", missing });

  try {
    const board = toPublicBoard(await rpc("wins_board"));
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(board);
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "Couldn't load wins." });
  }
}
