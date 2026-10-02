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
// It logs one line per sign-in (who, for which install, the outcome) so
// Kivali can see who signs in through its client. Codes and tokens are
// never logged; a short hash of the code ties a callback to its exchange.

const MAX_BODY = 8 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const INSTALL_CALLBACK_PATH = "/auth/callback";

export default {
  fetch(request, env) {
    return handle(request, env, { fetch: globalThis.fetch.bind(globalThis), log: console.log });
  },
};

/**
 * @param {Request} request
 * @param {{GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET?: string, CALLBACK_URL: string, GOOGLE_TOKEN_URL: string, LIMITER?: {limit(o: {key: string}): Promise<{success: boolean}>}}} env
 * @param {{fetch: typeof fetch, log: (line: string) => void}} deps
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
    return callbackRoute(url, ip, deps);
  }
  if (request.method !== "POST") return text(405, "method not allowed", { allow: "POST" });
  return tokenRoute(request, env, ip, deps);
}

// GET <base>/callback: Google's redirect URI for the public client. The
// install's own callback URL rides in `state` as <nonce>.<base64url(url)>;
// the browser is sent there with the query string passed through
// unchanged. Only an install's /auth/callback is ever a destination, over
// https except on loopback, so the relay cannot be used as an open
// redirect beyond that shape.
async function callbackRoute(url, ip, deps) {
  const state = url.searchParams.get("state") ?? "";
  const install = installFromState(state);
  if (!install) {
    deps.log(line({ event: "callback", outcome: "invalid state", ip }));
    return text(400, "invalid state");
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
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
      location: install.href + url.search,
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
// at its own redirect URI, adds the secret, forwards it to Google and
// returns Google's status and body verbatim. Google enforces PKCE, so a
// code is redeemable only with its verifier.
async function tokenRoute(request, env, ip, deps) {
  if (!env.GOOGLE_CLIENT_SECRET) {
    deps.log(line({ event: "token", outcome: "GOOGLE_CLIENT_SECRET is not set", ip }));
    return oauthError(500, "server_error", "the relay has no client secret");
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
  const code = form.get("code");
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

  const who = whoSignedIn(upstream.status, body);
  deps.log(
    line({
      event: "token",
      code: await shortHash(code),
      status: upstream.status,
      email: who.email,
      email_verified: who.emailVerified,
      hd: who.hd,
      outcome: upstream.ok ? "exchanged" : `google error: ${who.error ?? upstream.status}`,
      ip,
    }),
  );
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
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
  return "";
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

function base64urlDecode(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
