/* ============================================
   AI helpers: tries Puter.js first (free, no
   API key needed for the visitor), and falls
   back to a Cloudflare Worker proxy (which holds
   the real OpenRouter key server-side) only if
   Puter's actual AI call fails or hangs.

   Requires this still in your HTML:
   <script src="https://js.puter.com/v2/"></script>

   No API key goes in this file — it lives safely
   in your Cloudflare Worker's secret settings.
   ============================================ */

const WORKER_PROXY_URL = "https://study-invaders-proxy.nazminawen21.workers.dev/";
// Listed in priority order — if the first is rate-limited/down, OpenRouter
// automatically tries the next one for us.
const OPENROUTER_MODELS = [
  "thinkingmachines/inkling:free",
  "thinkingmachines/inkling-small:free",
  "google/gemma-4-31b-it:free"
];
// Only wraps the actual AI request after sign-in is done — never the
// sign-in step itself, since that depends on how fast a real person types.
const PUTER_CALL_TIMEOUT_MS = 15000;

// Strips stray markdown code fences the model sometimes adds, then parses.
function parseJsonResponse(raw){
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

// Rejects if `promise` doesn't settle within `ms` — needed because a broken
// Puter socket can hang indefinitely instead of throwing.
function withTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------- Puter.js path (primary) ---------- */

function extractResponseText(response){
  if(typeof response === 'string') return response;
  if(response?.message?.content){
    const content = response.message.content;
    if(typeof content === 'string') return content;
    if(Array.isArray(content) && content[0]?.text) return content[0].text;
  }
  if(response?.text) return response.text;
  return String(response);
}

async function uploadBase64AndGetUrl(base64, filename, mimeType){
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for(let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });

  const uploaded = await puter.fs.write(filename, blob);
  return await puter.fs.getReadURL(uploaded.path);
}

// Checks with a live call (getUser()) rather than a local/cached flag
// (isSignedIn()), so we don't act on stale session state.
let _authInFlight = null;
async function ensurePuterAuth(){
  try {
    const user = await puter.auth.getUser();
    if(user && user.username) return true;
  } catch(e){ /* not signed in, or session expired — fall through */ }

  if(_authInFlight){
    try { return await _authInFlight; } catch(e){ return false; }
  }

  _authInFlight = (async () => {
    try {
      await puter.auth.signIn(); // no timeout here — let the person take their time
      return true;
    } catch(e){
      console.error('Puter sign-in failed or was cancelled:', e);
      return false;
    } finally {
      _authInFlight = null;
    }
  })();

  return await _authInFlight;
}

const PUTER_MODEL_FALLBACKS = ['google/gemini-3.5-flash', 'google/gemini-3.1-flash-lite', 'gpt-5.4-nano'];

async function askAIViaPuter(prompt, note){
  if(typeof puter === 'undefined'){
    throw new Error('Puter.js script did not load');
  }
  const authed = await ensurePuterAuth();
  if(!authed) throw new Error('Puter sign-in did not complete');

  let lastErr;
  for(const model of PUTER_MODEL_FALLBACKS){
    try {
      const callPromise = (async () => {
        let response;
        if(note.isText){
          const fullPrompt = prompt + "\n\nNOTES CONTENT:\n" + note.content;
          response = await puter.ai.chat(fullPrompt, { model });
        } else if(note.isPdf){
          const fileUrls = await Promise.all(
            note.pageImages.map((img, i) =>
              uploadBase64AndGetUrl(img, `${note.name}-p${i + 1}.jpg`, 'image/jpeg')
            )
          );
          response = await puter.ai.chat(prompt, fileUrls, { model });
        } else {
          const fileUrl = await uploadBase64AndGetUrl(note.content, note.name, note.mimeType);
          response = await puter.ai.chat(prompt, fileUrl, { model });
        }
        return response;
      })();

      // Only the network call gets time-boxed — this is what was reportedly
      // hanging (the socket issue), not the sign-in the person just did.
      const response = await withTimeout(callPromise, PUTER_CALL_TIMEOUT_MS, `Puter (${model})`);
      return parseJsonResponse(extractResponseText(response));
    } catch(err){
      console.warn(`Puter model "${model}" failed, trying next fallback...`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

/* ---------- OpenRouter path (fallback) ---------- */

async function askAIViaOpenRouter(prompt, note){
  const contentParts = [{ type: 'text', text: prompt }];

  if(note.isText){
    contentParts[0].text += "\n\nNOTES CONTENT:\n" + note.content;
  } else if(note.isPdf){
    if(note.pagesIncluded < note.pageCount){
      contentParts[0].text += `\n\n(Note: this document has ${note.pageCount} pages; only the first ${note.pagesIncluded} are attached below.)`;
    }
    for(const pageBase64 of note.pageImages){
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${pageBase64}` }
      });
    }
  } else {
    const dataUrl = `data:${note.mimeType};base64,${note.content}`;
    contentParts.push({
      type: 'image_url',
      image_url: { url: dataUrl }
    });
  }

  let lastError;

  for(const model of OPENROUTER_MODELS){
    const requestBody = {
      model,
      messages: [{ role: 'user', content: contentParts }]
    };

    try {
      const response = await fetch(WORKER_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if(response.status === 429){
        lastError = new Error(`${model} is rate-limited`);
        await sleep(1500);
        continue;
      }

      if(!response.ok){
        const errText = await response.text();
        lastError = new Error(`AI proxy error (${response.status}) on ${model}: ${errText}`);
        continue;
      }

      const data = await response.json();
      const rawText = data?.choices?.[0]?.message?.content;
      if(!rawText){
        lastError = new Error(`No response text from ${model}`);
        continue;
      }

      return parseJsonResponse(rawText);
    } catch (err){
      lastError = err;
    }
  }

  throw lastError || new Error('All AI models failed');
}

/* ---------- Public entry point ---------- */

async function askAI(prompt, note){
  try {
    return await askAIViaPuter(prompt, note);
  } catch (err){
    console.warn('Puter AI unavailable, falling back to proxy:', err);
    return await askAIViaOpenRouter(prompt, note);
  }
}
