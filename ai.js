const fetch = globalThis.fetch || require("node-fetch");
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

async function pickWinner(gameState) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const squads = gameState.players.map((p) => ({
    playerId: p.id,
    name: p.name,
    purseRemaining: p.purse,
    squad: p.squad
  }));

  const prompt = [
    "You are an IPL-style auction analyst.",
    "Given the squads, pick the single playerId with the strongest and most balanced team.",
    "Balance scoring higher than star power if needed.",
    "Return only the playerId, no extra text.",
    "Input squads JSON:",
    JSON.stringify({ gameId: gameState.id, squads }, null, 2)
  ].join("\n");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("OpenAI error:", res.status, text);
    return null;
  }

  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  return answer || null;
}

module.exports = { pickWinner };

