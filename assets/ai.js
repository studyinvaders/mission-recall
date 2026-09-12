/* ============================================
   AI Helper: Powered by Cloudflare Worker + Gemini
   ============================================ */

const WORKER_URL = "https://study-invaders-proxy.nawen211.workers.dev/";

function parseJsonResponse(raw){
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

async function askAI(prompt, note){
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, note })
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return parseJsonResponse(data.text);
}
