function trimSlash(u) {
  u = String(u || "");
  while (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeRead(r) {
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { text, json };
}

function notConfigured(message) {
  return { ok: false, status: 412, json: null, text: "", error: message };
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { ctrl, clear: () => clearTimeout(t) };
}

function pickTimeout(cfg) {
  const v = Number(cfg?.AI_TIMEOUT_MS || cfg?.AI_TIMEOUT || 20000);
  return Number.isFinite(v) && v > 0 ? v : 20000;
}

function pickModel(cfg, override) {
  const m = String(override || cfg?.AI_MODEL || "").trim();
  return m || undefined;
}

function isRetryableStatus(status) {
  // 408: request timeout, 429: rate, 500/502/503/504 transient
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function redact(s) {
  s = String(s || "");
  if (s.length <= 400) return s;
  return s.slice(0, 400) + "…";
}

function web3Mode(cfg) {
  const m = String(cfg?.WEB3_CHAT_MODE || "auto").trim().toLowerCase();
  return (m === "on" || m === "off" || m === "auto") ? m : "auto";
}

async function aiGet(cfg, path, opts = {}) {
  const base = trimSlash(cfg?.COOKMYBOTS_AI_ENDPOINT || "");
  const key = String(cfg?.COOKMYBOTS_AI_KEY || "");
  const DEBUG = String(cfg?.AI_DEBUG || "") === "1";
  if (!base || !key) return notConfigured("AI_NOT_CONFIGURED (missing COOKMYBOTS_AI_ENDPOINT/COOKMYBOTS_AI_KEY)");

  const timeoutMs = Number(opts.timeoutMs || pickTimeout(cfg));
  const url = base + String(path || "");

  const { ctrl, clear } = withTimeout(timeoutMs);
  try {
    if (DEBUG) console.log("[aiGet] ->", url);
    const r = await fetch(url, { method: "GET", headers: { Authorization: "Bearer " + key }, signal: ctrl.signal });
    const { text, json } = await safeRead(r);
    if (!r.ok) {
      const err = json?.error || json?.message || text || "AI_ERROR";
      return { ok: false, status: r.status, json, text, error: String(err) };
    }
    return { ok: true, status: r.status, json, text, error: null };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "AI_TIMEOUT" : (e?.message || "AI_NETWORK_ERROR");
    return { ok: false, status: e?.name === "AbortError" ? 408 : 0, json: null, text: "", error: String(msg) };
  } finally {
    clear();
  }
}

async function routeChat(cfg, userText, systemHint) {
  // Uses the normal gateway /chat as a fast classifier.
  // Returns: "web3" | "normal"
  const base = trimSlash(cfg?.COOKMYBOTS_AI_ENDPOINT || "");
  const key = String(cfg?.COOKMYBOTS_AI_KEY || "");
  if (!base || !key) return "normal";

  const timeoutMs = Math.min(8000, pickTimeout(cfg));
  const { ctrl, clear } = withTimeout(timeoutMs);

  const sys = [
    "You are a routing classifier for a bot.",
    "Decide if the user's message should go to a Web3 specialist model (ChainGPT) or a normal general AI model.",
    "",
    "Return ONLY valid JSON:",
    '{"route":"web3"}',
    "or",
    '{"route":"normal"}',
    "",
    "Route to web3 if the user asks about: crypto, tokens, Solidity, smart contracts, audits, DeFi, NFTs, wallets, chains, bridges, gas, DEXs, on-chain tools or anything related to blockchain.",
    "Otherwise route to normal.",
    "",
    "Extra context (bot/system hint):",
    String(systemHint || "").slice(0, 800),
  ].join("\n");

  try {
    const r = await fetch(base + "/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: sys },
          { role: "user", content: String(userText || "").slice(0, 2000) },
        ],
        model: pickModel(cfg, ""), // let gateway default or AI_MODEL
        meta: { purpose: "route" },
      }),
      signal: ctrl.signal,
    });

    const { text, json } = await safeRead(r);
    if (!r.ok) return "normal";

    // Try common shapes: gateway might return {text} or OpenAI-like {choices}
    const out =
      (json && (json.text || json.message)) ||
      (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ||
      text ||
      "";

    const raw = String(out || "").trim();

    // Parse JSON safely
    try {
      const obj = JSON.parse(raw);
      const route = String(obj?.route || "").toLowerCase();
      return route === "web3" ? "web3" : "normal";
    } catch {
      // If model returned non-JSON, fallback to normal
      return "normal";
    }
  } catch {
    return "normal";
  } finally {
    clear();
  }
}

/**
 * Low-level gateway call.
 * Always returns: { ok, status, json, text, error }
 * - json is parsed response body (if JSON)
 * - error is a short string for logs/UI
 */
export async function aiCall(cfg, path, body, opts = {}) {
  const base = trimSlash(cfg?.COOKMYBOTS_AI_ENDPOINT || "");
  const key = String(cfg?.COOKMYBOTS_AI_KEY || "");
  const DEBUG = String(cfg?.AI_DEBUG || "") === "1";

  if (!base || !key) return notConfigured("AI_NOT_CONFIGURED (missing COOKMYBOTS_AI_ENDPOINT/COOKMYBOTS_AI_KEY)");

  const timeoutMs = Number(opts.timeoutMs || pickTimeout(cfg));
  const retries = Number.isFinite(opts.retries) ? Number(opts.retries) : 1; // default 1 retry
  const backoffMs = Number.isFinite(opts.backoffMs) ? Number(opts.backoffMs) : 750;

  const url = base + String(path || "");
  const started = Date.now();

  let attempt = 0;
  while (true) {
    attempt++;

    const { ctrl, clear } = withTimeout(timeoutMs);
    try {
      if (DEBUG) console.log("[aiCall] ->", url, { attempt, timeoutMs });

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });

      const { text, json } = await safeRead(r);

      if (!r.ok) {
        const err = json?.error || json?.message || text || "AI_ERROR";
        const out = { ok: false, status: r.status, json, text, error: String(err) };

        if (DEBUG) {
          const ms = Date.now() - started;
          console.warn("[aiCall] <- fail", { status: r.status, ms, attempt, err: redact(err) });
        }

        // Retry transient errors
        if (attempt <= retries && isRetryableStatus(r.status)) {
          await sleep(backoffMs * attempt);
          continue;
        }

        return out;
      }

      if (DEBUG) {
        const ms = Date.now() - started;
        console.log("[aiCall] <- ok", { status: r.status, ms, attempt });
      }

      return { ok: true, status: r.status, json, text, error: null };
    } catch (e) {
      const msg = e?.name === "AbortError" ? "AI_TIMEOUT" : (e?.message || "AI_NETWORK_ERROR");
      const out = { ok: false, status: e?.name === "AbortError" ? 408 : 0, json: null, text: "", error: String(msg) };

      if (DEBUG) {
        const ms = Date.now() - started;
        console.warn("[aiCall] <- exception", { ms, attempt, err: redact(msg) });
      }

      // Retry network/timeout issues (status 0/408)
      if (attempt <= retries) {
        await sleep(backoffMs * attempt);
        continue;
      }

      return out;
    } finally {
      clear();
    }
  }
}

/**
 * CHAT
 * Backward compatible:
 * 1) aiChat(cfg, "hello", { model, meta, system })
 * 2) aiChat(cfg, { messages:[...], model, meta })
 *
 * Returns: { ok, status, json, text, error }
 */
export async function aiChat(cfg, input, opts = {}) {
  // Signature (cfg, { messages, model, meta })
  if (input && typeof input === "object" && Array.isArray(input.messages)) {
    const model = pickModel(cfg, input.model);
    return aiCall(cfg, "/chat", {
      messages: input.messages,
      model,
      meta: input.meta || undefined,
    }, opts);
  }

  // Signature (cfg, "prompt")
  const userText = String(input || "");
  const system = String(opts.system || "You are a helpful assistant.");
  const model = pickModel(cfg, opts.model);

  return aiCall(cfg, "/chat", {
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    model,
    meta: opts.meta || undefined,
  }, opts);
}

// IMAGE
export async function aiImage(cfg, { prompt, size = "1024x1024", n = 1, model = "", meta } = {}, opts = {}) {
  const m = pickModel(cfg, model);
  return aiCall(cfg, "/image", { prompt, size, n, model: m, meta: meta || undefined }, opts);
}

// VISION
export async function aiVision(cfg, { prompt, imageUrl, model = "", meta } = {}, opts = {}) {
  const m = pickModel(cfg, model);
  return aiCall(cfg, "/vision", { prompt, imageUrl, model: m, meta: meta || undefined }, opts);
}

// EMBEDDINGS
export async function aiEmbeddings(cfg, { input, model = "", meta } = {}, opts = {}) {
  const m = pickModel(cfg, model);
  return aiCall(cfg, "/embeddings", { input, model: m, meta: meta || undefined }, opts);
}

// WEB SEARCH
export async function aiWebSearch(cfg, { query, meta } = {}, opts = {}) {
  return aiCall(cfg, "/web-search", { query, meta: meta || undefined }, opts);
}

// SPEECH
export async function aiSpeechTts(cfg, { text, voice = "alloy", format = "mp3", model = "", meta } = {}, opts = {}) {
  const m = pickModel(cfg, model);
  return aiCall(cfg, "/speech/tts", { text, voice, format, model: m, meta: meta || undefined }, opts);
}

export async function aiSpeechStt(cfg, { audioBase64, mimeType = "audio/mpeg", filename = "audio.mp3", durationSeconds = 0, model = "", meta } = {}, opts = {}) {
  const m = pickModel(cfg, model);
  return aiCall(cfg, "/speech/stt", { audioBase64, mimeType, filename, durationSeconds, model: m, meta: meta || undefined }, opts);
}

// VIDEO
export async function aiVideoCreate(cfg, { prompt, seconds = 4, size = "1024x576", model = "", meta } = {}, opts = {}) {
  const m = pickModel(cfg, model);
  return aiCall(cfg, "/video/create", { prompt, seconds, size, model: m, meta: meta || undefined }, opts);
}

/**
 * Video status is GET in many gateways.
 * If your gateway is POST-only, you can keep it as GET via fetch() here.
 */
export async function aiVideoStatus(cfg, jobId, opts = {}) {
  const base = trimSlash(cfg?.COOKMYBOTS_AI_ENDPOINT || "");
  const key = String(cfg?.COOKMYBOTS_AI_KEY || "");
  const DEBUG = String(cfg?.AI_DEBUG || "") === "1";

  if (!base || !key) return notConfigured("AI_NOT_CONFIGURED (missing COOKMYBOTS_AI_ENDPOINT/COOKMYBOTS_AI_KEY)");

  const timeoutMs = Number(opts.timeoutMs || pickTimeout(cfg));
  const url = base + "/video/" + encodeURIComponent(String(jobId || ""));

  const { ctrl, clear } = withTimeout(timeoutMs);
  try {
    if (DEBUG) console.log("[aiVideoStatus] ->", url);

    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + key },
      signal: ctrl.signal,
    });

    const { text, json } = await safeRead(r);

    if (!r.ok) {
      const err = json?.error || json?.message || text || "AI_VIDEO_STATUS_ERROR";
      if (DEBUG) console.warn("[aiVideoStatus] failed:", r.status, redact(err));
      return { ok: false, status: r.status, json, text, error: String(err) };
    }

    return { ok: true, status: r.status, json, text, error: null };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "AI_TIMEOUT" : (e?.message || "AI_NETWORK_ERROR");
    if (DEBUG) console.warn("[aiVideoStatus] exception:", redact(msg));
    return { ok: false, status: e?.name === "AbortError" ? 408 : 0, json: null, text: "", error: String(msg) };
  } finally {
    clear();
  }
}

export async function aiChainGptChat(cfg, { mode = "web3", question, meta } = {}, opts = {}) {
  const m = web3Mode(cfg);
  if (m === "off") return notConfigured("WEB3_DISABLED (WEB3_CHAT_MODE=off)");

  // mode: "web3" | "smart_contract_generator" | "smart_contract_auditor"
  return aiCall(cfg, "/chaingpt/chat", {
    mode: String(mode || "web3"),
    question: String(question || ""),
    meta: meta || undefined,
  }, opts);
}

export async function aiChainGptNews(cfg, { limit = 5 } = {}, opts = {}) {
  const m = web3Mode(cfg);
  if (m === "off") return notConfigured("WEB3_DISABLED (WEB3_CHAT_MODE=off)");
  const q = Number(limit || 5);
  const lim = Number.isFinite(q) ? Math.max(1, Math.min(q, 20)) : 5;
  return aiGet(cfg, "/chaingpt/news?limit=" + encodeURIComponent(String(lim)), opts);
}

export async function aiChainGptNftImage(cfg, { prompt, model = "velogen", steps = 2, width = 512, height = 512, enhance = "1x", meta } = {}, opts = {}) {
  const m = web3Mode(cfg);
  if (m === "off") return notConfigured("WEB3_DISABLED (WEB3_CHAT_MODE=off)");

  return aiCall(cfg, "/chaingpt/nft/image", {
    prompt: String(prompt || ""),
    model: String(model || "velogen"),
    steps: Number(steps || 2),
    width: Number(width || 512),
    height: Number(height || 512),
    enhance: String(enhance || "1x"),
    meta: meta || undefined,
  }, opts);
}

// Convenience: auto-route to ChainGPT if it looks web3, else normal aiChat()
export async function aiSmartChat(cfg, userText, { system = "", meta = {}, retries = 1 } = {}) {
  const m = web3Mode(cfg);

  // Forced modes
  if (m === "on") {
    return aiChainGptChat(cfg, { mode: "web3", question: String(userText || ""), meta }, { retries });
  }
  if (m === "off") {
    return aiChat(cfg, String(userText || ""), { system: system || "You are a helpful assistant.", meta, retries });
  }

  // AUTO mode: AI decides route
  const route = await routeChat(cfg, userText, system);

  if (route === "web3") {
    return aiChainGptChat(cfg, { mode: "web3", question: String(userText || ""), meta }, { retries });
  }

  return aiChat(cfg, String(userText || ""), { system: system || "You are a helpful assistant.", meta, retries });
}
