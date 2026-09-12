/* ============================================
   AI helper: Puter.js only. No fallback, on
   purpose — the whole point of this rebuild is
   to see clearly whether Puter itself works, so
   a silent safety net would just hide the answer.

   Requires this still in your HTML:
   <script src="https://js.puter.com/v2/"></script>
   ============================================ */

// Only wraps the actual AI request after sign-in is done — never the
// sign-in step itself, since that depends on how fast a real person types.
const PUTER_CALL_TIMEOUT_MS = 30000;
// Pause between fallback attempts so a failed/timed-out call doesn't
// immediately fire another request right on its heels — back-to-back
// requests are a likely trigger for "too many requests" on their own.
const PUTER_RETRY_DELAY_MS = 4000;

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

/* ---------- Puter.js path ---------- */

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
  for(let i = 0; i < PUTER_MODEL_FALLBACKS.length; i++){
    const model = PUTER_MODEL_FALLBACKS[i];
    if(i > 0){
      // Back off longer if the previous failure looked like a rate limit,
      // since retrying fast is exactly what would make that worse.
      const wasRateLimited = lastErr && /too many requests|rate.?limit/i.test(lastErr.message || lastErr.error || '');
      await sleep(wasRateLimited ? PUTER_RETRY_DELAY_MS * 2 : PUTER_RETRY_DELAY_MS);
    }
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

/* ---------- Public entry point ---------- */

// Puter only — errors surface directly instead of being masked by a fallback.
async function askAI(prompt, note){
  return await askAIViaPuter(prompt, note);
}
