// The sign-in relay for Kivali's public Google OAuth client.
//
// The contract is docs/AUTH.md in the kivali repo ("The public client and
// the relay"). In short: every install starts a PKCE authorization-code
// sign-in against one shared Google client and names itself in `state`;
// Google comes back here; this relay bounces the browser to that install
// and later adds the client secret to the install's token exchange. The
// install trusts only Google's signed id_token, never this relay, so the
// relay can neither sign anyone in nor learn a session. It stores nothing.
//
// `state` is whatever the browser brought, so anyone can name any install
// in it, including one they run. The browser therefore never carries
// Google's code: the callback seals it, with the install it is sent to and
// an expiry, under a key only this relay holds, and the token route redeems
// a sealed code only for the install it was sealed for. A code lured to
// another address cannot be redeemed by any other install.
//
// It logs one line per sign-in (who, for which install, the outcome) so
// Kivali can see who signs in through its client. Codes and tokens are
// never logged; a short hash of the code ties a callback to its exchange.

const MAX_BODY = 8 * 1024;
// How long a sealed code can be redeemed: the install's own sign-in
// window. Google's codes expire sooner than this anyway.
const SEAL_TTL_MS = 10 * 60 * 1000;
const SEAL_PREFIX = "k1.";
const SEAL_AAD = new TextEncoder().encode("kivali-relay-code-v1");
const MIN_SEAL_KEY = 32;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const INSTALL_CALLBACK_PATH = "/auth/callback";

export default {
  fetch(request, env) {
    return handle(request, env, { fetch: globalThis.fetch.bind(globalThis), log: console.log, now: Date.now });
  },
};

/**
 * @param {Request} request
 * @param {{GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET?: string, RELAY_SEAL_KEY?: string, CALLBACK_URL: string, GOOGLE_TOKEN_URL: string, LIMITER?: {limit(o: {key: string}): Promise<{success: boolean}>}}} env
 * @param {{fetch: typeof fetch, log: (line: string) => void, now?: () => number}} deps
 */
export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const callback = new URL(env.CALLBACK_URL);
  const prefix = callback.pathname.replace(/\/callback$/, "");
  const ip = request.headers.get("cf-connecting-ip") ?? "";

  if (url.pathname !== `${prefix}/callback` && url.pathname !== `${prefix}/token`) {
    return text(404, "not found");
  }
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return text(429, "too many requests");
  }
  if (url.pathname === `${prefix}/callback`) {
    if (request.method !== "GET") return text(405, "method not allowed", { allow: "GET" });
    return callbackRoute(url, env, ip, deps);
  }
  if (request.method !== "POST") return text(405, "method not allowed", { allow: "POST" });
  return tokenRoute(request, env, ip, deps);
}

// GET <base>/callback: Google's redirect URI for the public client. The
// install's own callback URL rides in `state` as <nonce>.<base64url(url)>;
// the browser is sent there with Google's query string, except that the
// code is replaced by the code sealed for that install. Only an install's
// /auth/callback is ever a destination, over https except on loopback.
async function callbackRoute(url, env, ip, deps) {
  const state = url.searchParams.get("state") ?? "";
  const install = installFromState(state);
  if (!install) {
    deps.log(line({ event: "callback", outcome: "invalid state", ip }));
    return text(400, "invalid state");
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const query = new URLSearchParams(url.searchParams);
  if (code) {
    const key = await sealKey(env);
    if (!key) {
      // Never hand a browser a code this relay could not bind.
      deps.log(line({ event: "callback", install: install.origin, outcome: "RELAY_SEAL_KEY is not set", ip }));
      return text(500, "the relay is not configured");
    }
    query.set("code", await seal(key, { c: code, r: install.href, e: now(deps) + SEAL_TTL_MS }));
  }
  deps.log(
    line({
      event: "callback",
      install: install.origin,
      code: code ? await shortHash(code) : undefined,
      outcome: error ? `google error: ${error}` : code ? "redirected" : "no code",
      ip,
    }),
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: `${install.href}?${query}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** @returns {URL | null} the install's callback URL named in state, if acceptable */
export function installFromState(state) {
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  let decoded;
  try {
    decoded = base64urlDecode(state.slice(dot + 1));
  } catch {
    return null;
  }
  let u;
  try {
    u = new URL(decoded);
  } catch {
    return null;
  }
  if (u.pathname !== INSTALL_CALLBACK_PATH || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") {
    return null;
  }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return u;
  return null;
}

// POST <base>/token: the install's code exchange, server to server. The
// relay accepts only an authorization-code exchange for the public client
// at its own redirect URI, with a code it sealed for the install named in
// return_url. It opens the code, adds the secret, forwards it to Google and
// returns Google's error verbatim or, on success, the id_token alone: the
// install signs in on the id_token and nothing else, so no access or
// refresh token ever leaves the relay. Google enforces PKCE, so a code is
// redeemable only with its verifier.
async function tokenRoute(request, env, ip, deps) {
  if (!env.GOOGLE_CLIENT_SECRET) {
    deps.log(line({ event: "token", outcome: "GOOGLE_CLIENT_SECRET is not set", ip }));
    return oauthError(500, "server_error", "the relay has no client secret");
  }
  const key = await sealKey(env);
  if (!key) {
    deps.log(line({ event: "token", outcome: "RELAY_SEAL_KEY is not set", ip }));
    return oauthError(500, "server_error", "the relay has no sealing key");
  }
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    return oauthError(400, "invalid_request", "expected application/x-www-form-urlencoded");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return oauthError(413, "invalid_request", "request too large");
  const form = new URLSearchParams(raw);

  const refused = refuseExchange(form, env);
  if (refused) {
    deps.log(line({ event: "token", outcome: `refused: ${refused}`, ip }));
    return oauthError(400, "invalid_request", refused);
  }
  // Compared as the URL it names, as the callback recorded it, so a host's
  // case or an explicit default port does not refuse a genuine install.
  const claimed = normalURL(form.get("return_url"));
  const opened = await unseal(key, form.get("code"));
  const grantRefused = !opened
    ? "code was not issued by this relay"
    : opened.e < now(deps)
      ? "code has expired"
      : opened.r !== claimed
        ? "code was issued for another install"
        : "";
  if (grantRefused) {
    deps.log(
      line({
        event: "token",
        install: originOf(claimed),
        sealed_for: opened ? originOf(opened.r) : undefined,
        outcome: `refused: ${grantRefused}`,
        ip,
      }),
    );
    return oauthError(400, "invalid_grant", grantRefused);
  }
  const code = opened.c;
  const forward = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: form.get("code_verifier"),
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.CALLBACK_URL,
  });

  const upstream = await deps.fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: forward.toString(),
  });
  const body = await upstream.text();
  const answer = upstream.ok ? idTokenOnly(body) : null;

  const who = whoSignedIn(upstream.status, body);
  deps.log(
    line({
      event: "token",
      // The install the code was sealed for: the relay wrote it, so unlike
      // anything in a callback line it cannot be made up by a caller.
      install: originOf(opened.r),
      code: await shortHash(code),
      status: upstream.status,
      email: who.email,
      email_verified: who.emailVerified,
      hd: who.hd,
      outcome: !upstream.ok ? `google error: ${who.error ?? upstream.status}` : answer ? "exchanged" : "no id_token from google",
      ip,
    }),
  );
  if (!upstream.ok) {
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }
  if (!answer) return oauthError(502, "server_error", "Google's answer carried no id_token");
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** @returns {string} why the exchange is refused, or "" to let it through */
export function refuseExchange(form, env) {
  if (form.get("grant_type") !== "authorization_code") return "grant_type must be authorization_code";
  if (form.get("client_id") !== env.GOOGLE_CLIENT_ID) return "client_id is not the public client";
  if (form.get("redirect_uri") !== env.CALLBACK_URL) return "redirect_uri is not the relay's callback";
  if (form.has("client_secret")) return "client_secret is not accepted";
  if (!form.get("code")) return "code is required";
  if (!form.get("code_verifier")) return "code_verifier is required";
  if (!form.get("return_url")) return "return_url is required";
  return "";
}

// The parts of a successful token response an install may have: the
// id_token and its framing. The access token, refresh token and scope stay
// here, so the relay cannot be used to mint Google API access.
export function idTokenOnly(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed?.id_token !== "string" || parsed.id_token === "") return null;
  const out = { id_token: parsed.id_token };
  if (typeof parsed.token_type === "string") out.token_type = parsed.token_type;
  if (typeof parsed.expires_in === "number") out.expires_in = parsed.expires_in;
  return out;
}

// Who signed in, read from the id_token in Google's answer. For logging
// only: the install verifies the token's signature itself. Google's
// answer came straight from Google over TLS, so for a log line its claims
// are good enough as they are.
export function whoSignedIn(status, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (status >= 400) return { error: typeof parsed?.error === "string" ? parsed.error : undefined };
  const idToken = parsed?.id_token;
  if (typeof idToken !== "string") return {};
  const parts = idToken.split(".");
  if (parts.length !== 3) return {};
  try {
    const claims = JSON.parse(base64urlDecode(parts[1]));
    return {
      email: typeof claims.email === "string" ? claims.email : undefined,
      emailVerified: claims.email_verified === true || claims.email_verified === "true" ? true : undefined,
      hd: typeof claims.hd === "string" ? claims.hd : undefined,
    };
  } catch {
    return {};
  }
}

// The AES-GCM key codes are sealed under, from RELAY_SEAL_KEY, a random
// value only this relay holds (deliberately not the client secret: whoever
// learned that secret could otherwise open sealed codes too). Null when the
// key is unset or too short to be one.
async function sealKey(env) {
  const secret = env.RELAY_SEAL_KEY;
  if (typeof secret !== "string" || secret.length < MIN_SEAL_KEY) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** @param {{c: string, r: string, e: number}} payload the code, the install's callback URL, the expiry in ms */
export async function seal(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SEAL_AAD }, key, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return SEAL_PREFIX + base64urlEncode(out);
}

/** @returns {Promise<{c: string, r: string, e: number} | null>} the sealed payload, or null if this relay did not seal it */
export async function unseal(key, value) {
  if (typeof value !== "string" || !value.startsWith(SEAL_PREFIX)) return null;
  try {
    const bytes = base64urlBytes(value.slice(SEAL_PREFIX.length));
    if (bytes.length <= 12) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: SEAL_AAD }, key, bytes.slice(12));
    const p = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    if (typeof p?.c !== "string" || typeof p.r !== "string" || typeof p.e !== "number") return null;
    return p;
  } catch {
    return null;
  }
}

function base64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function normalURL(href) {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

function originOf(href) {
  try {
    return new URL(href).origin;
  } catch {
    return undefined;
  }
}

function now(deps) {
  return (deps.now ?? Date.now)();
}

function base64urlDecode(s) {
  return new TextDecoder("utf-8", { fatal: true }).decode(base64urlBytes(s));
}

// The first eight hex digits of SHA-256(code): enough to tie a callback
// to its exchange in the logs, useless for redeeming the code.
async function shortHash(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function line(fields) {
  const out = { at: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") out[k] = v;
  return JSON.stringify(out);
}

function text(status, body, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function oauthError(status, error, description) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
