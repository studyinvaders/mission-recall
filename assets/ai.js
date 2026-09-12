/* ============================================
   AI helper: Puter.js with Rate Limit Handling
   ============================================ */

const PUTER_CALL_TIMEOUT_MS = 30000;
const PUTER_RETRY_DELAY_MS = 4000;

// Strips stray markdown code fences the model sometimes adds, then parses JSON.
function parseJsonResponse(raw){
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

// Rejects if `promise` doesn't settle within `ms`
function withTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function uploadBase64AndGetUrl(base64Data, filename, mimeType){
  // Strip Data URL prefix if present (e.g., "data:image/jpeg;base64,")
  const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const byteChars = atob(cleanBase64);
  const byteNumbers = new Array(byteChars.length);
  for(let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });

  const uploaded = await puter.fs.write(filename, blob);
  return await puter.fs.getReadURL(uploaded.path);
}

let _authInFlight = null;
async function ensurePuterAuth(){
  try {
    const user = await puter.auth.getUser();
    if(user && user.username) return true;
  } catch(e){ /* session expired — fall through */ }

  if(_authInFlight){
    try { return await _authInFlight; } catch(e){ return false; }
  }

  _authInFlight = (async () => {
    try {
      await puter.auth.signIn();
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

async function askAIViaPuter(prompt, note){
  if(typeof puter === 'undefined'){
    throw new Error('Puter.js script did not load');
  }
  const authed = await ensurePuterAuth();
  if(!authed) throw new Error('Puter sign-in did not complete');

  // Passing 'undefined' first lets Puter use its default load-balanced route
  const PUTER_MODEL_FALLBACKS = [
    undefined, 
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini'
  ];

  let lastErr;
  for(let i = 0; i < PUTER_MODEL_FALLBACKS.length; i++){
    const model = PUTER_MODEL_FALLBACKS[i];
    
    if(i > 0){
      const wasRateLimited = lastErr && /too many requests|rate.?limit/i.test(
        lastErr.message || lastErr.error || JSON.stringify(lastErr)
      );
      // Back off longer (8s) if rate-limited, otherwise wait 3s before retrying
      const delay = wasRateLimited ? 8000 : 3000;
      await sleep(delay);
    }

    try {
      const callPromise = (async () => {
        const options = model ? { model } : {};
        if(note.isText){
          const fullPrompt = prompt + "\n\nNOTES CONTENT:\n" + note.content;
          return await puter.ai.chat(fullPrompt, options);
        } else if(note.isPdf){
          const fileUrls = await Promise.all(
            note.pageImages.map((img, idx) =>
              uploadBase64AndGetUrl(img, `${note.name}-p${idx + 1}.jpg`, 'image/jpeg')
            )
          );
          const messages = [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...fileUrls.map(url => ({ type: 'image_url', image_url: { url } }))
            ]
          }];
          return await puter.ai.chat(messages, options);
        } else {
          const fileUrl = await uploadBase64AndGetUrl(note.content, note.name, note.mimeType);
          const messages = [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: fileUrl } }
            ]
          }];
          return await puter.ai.chat(messages, options);
        }
      })();

      const response = await withTimeout(callPromise, PUTER_CALL_TIMEOUT_MS, `Puter (${model || 'default'})`);
      return parseJsonResponse(extractResponseText(response));
    } catch(err){
      console.warn(`Puter attempt ${i + 1} failed:`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

/* ---------- Public entry point ---------- */

async function askAI(prompt, note){
  return await askAIViaPuter(prompt, note);
}
