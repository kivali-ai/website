import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, idTokenOnly, installFromState, refuseExchange, whoSignedIn } from "./index.js";

const CLIENT_ID = "508969299515-ol3l2a67ola8hfm2loru9ne8hksl8kfq.apps.googleusercontent.com";
const CALLBACK = "https://kivali.ai/oauth/google/callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN = "https://kivali.ai/oauth/google/token";
const SEAL_KEY = "test-seal-key-0123456789abcdefghijklmnopqrstuvwxyz";
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

function env(extra = {}) {
  return { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "s3cret", RELAY_SEAL_KEY: SEAL_KEY, CALLBACK_URL: CALLBACK, GOOGLE_TOKEN_URL: TOKEN_URL, ...extra };
}

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stateFor(installURL, nonce = "n0nce") {
  return `${nonce}.${b64url(installURL)}`;
}

// A fake Google token endpoint, a log sink and a settable clock, returned as deps.
function deps(upstream = { status: 200, body: "{}" }) {
  const calls = [];
  const logs = [];
  const clock = { t: T0 };
  return {
    calls,
    logs,
    clock,
    now: () => clock.t,
    log: (l) => logs.push(JSON.parse(l)),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json" } });
    },
  };
}

function idToken(claims) {
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

// Google's code as the relay's callback seals it for `install`.
async function sealedCode(install, d, code = "4/abcDEF") {
  const res = await handle(new Request(`${CALLBACK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateFor(install))}`), env(), d);
  assert.equal(res.status, 302);
  return new URL(res.headers.get("location")).searchParams.get("code");
}

function exchange(fields) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code_verifier: "verifier123", client_id: CLIENT_ID, redirect_uri: CALLBACK, ...fields });
  return new Request(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.7" }, body: body.toString() });
}

test("callback bounces the browser to the install named in state, with the code sealed and the rest of the query unchanged", async () => {
  const d = deps();
  const install = "https://org.example.com/auth/callback";
  const q = `?state=${encodeURIComponent(stateFor(install))}&code=4%2FabcDEF&scope=openid+email&authuser=0&prompt=consent`;
  const res = await handle(new Request(`${CALLBACK}${q}`, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env(), d);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin + location.pathname, install);
  const sent = new URLSearchParams(q);
  assert.deepEqual([...location.searchParams.keys()], [...sent.keys()]);
  for (const k of ["state", "scope", "authuser", "prompt"]) assert.equal(location.searchParams.get(k), sent.get(k));
  assert.match(location.searchParams.get("code"), /^k1\.[A-Za-z0-9_-]+$/);
  assert.ok(!res.headers.get("location").includes("abcDEF"), "the browser must never carry Google's code");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(d.logs.length, 1);
  assert.equal(d.logs[0].event, "callback");
  assert.equal(d.logs[0].install, "https://org.example.com");
  assert.equal(d.logs[0].outcome, "redirected");
  assert.equal(d.logs[0].ip, "203.0.113.9");
  assert.match(d.logs[0].code, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(d.logs).includes("abcDEF"), "the code must never be logged");
});

test("callback passes Google's error through to the install", async () => {
  const d = deps();
  const install = "http://127.0.0.1:8080/auth/callback";
  const q = `?error=access_denied&state=${encodeURIComponent(stateFor(install))}`;
  const res = await handle(new Request(`${CALLBACK}${q}`), env(), d);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `${install}?${new URLSearchParams(q)}`);
  assert.equal(d.logs[0].outcome, "google error: access_denied");
  assert.equal(d.logs[0].install, "http://127.0.0.1:8080");
});

test("callback refuses a state that names anything but an install's /auth/callback", async () => {
  const bad = [
    "",
    "nodot",
    ".onlyurl",
    "nonce.",
    "nonce.!!!",
    stateFor("https://org.example.com/somewhere/else"),
    stateFor("https://org.example.com/auth/callback?x=1"),
    stateFor("https://org.example.com/auth/callback#frag"),
    stateFor("https://user:pw@org.example.com/auth/callback"),
    stateFor("http://org.example.com/auth/callback"),
    stateFor("http://192.168.1.10:8080/auth/callback"),
    stateFor("javascript:alert(1)"),
    stateFor("not a url"),
  ];
  for (const state of bad) {
    const d = deps();
    const res = await handle(new Request(`${CALLBACK}?code=x&state=${encodeURIComponent(state)}`), env(), d);
    assert.equal(res.status, 400, `state ${JSON.stringify(state)} should be refused`);
    assert.equal(d.logs[0].outcome, "invalid state");
  }
});

test("installFromState accepts https anywhere and http only on loopback", () => {
  assert.equal(installFromState(stateFor("https://org.example.com:8443/auth/callback")).href, "https://org.example.com:8443/auth/callback");
  assert.equal(installFromState(stateFor("http://127.0.0.1:54321/auth/callback")).href, "http://127.0.0.1:54321/auth/callback");
  assert.equal(installFromState(stateFor("http://localhost:8080/auth/callback")).href, "http://localhost:8080/auth/callback");
  assert.equal(installFromState(stateFor("http://[::1]:8080/auth/callback")).href, "http://[::1]:8080/auth/callback");
  assert.equal(installFromState(stateFor("http://127.0.0.2:8080/auth/callback")), null);
  assert.equal(installFromState(stateFor("ftp://org.example.com/auth/callback")), null);
});

test("callback refuses to hand on a code it cannot seal", async () => {
  for (const key of [undefined, "too-short"]) {
    const d = deps();
    const res = await handle(new Request(`${CALLBACK}?code=4%2FabcDEF&state=${encodeURIComponent(stateFor("https://org.example.com/auth/callback"))}`), env({ RELAY_SEAL_KEY: key }), d);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("location"), null);
    assert.equal(d.logs[0].outcome, "RELAY_SEAL_KEY is not set");
  }
});

test("callback takes GET only", async () => {
  const res = await handle(new Request(`${CALLBACK}?code=x&state=${stateFor("https://o.example/auth/callback")}`, { method: "POST" }), env(), deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("token opens the sealed code for its install, adds the secret, and returns the id_token alone, logging who signed in", async () => {
  const id = idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, email: "evan@example.com", email_verified: true, hd: "example.com", nonce: "n0nce" });
  const google = JSON.stringify({ access_token: "ya29.secret", refresh_token: "1//refresh", scope: "openid email", id_token: id, token_type: "Bearer", expires_in: 3599 });
  const d = deps({ status: 200, body: google });
  const install = "https://org.example.com/auth/callback";
  const code = await sealedCode(install, d);
  const res = await handle(exchange({ code, return_url: install }), env(), d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id_token: id, token_type: "Bearer", expires_in: 3599 });
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");

  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, TOKEN_URL);
  assert.equal(d.calls[0].init.method, "POST");
  const sent = new URLSearchParams(d.calls[0].init.body);
  assert.deepEqual([...sent.keys()].sort(), ["client_id", "client_secret", "code", "code_verifier", "grant_type", "redirect_uri"]);
  assert.equal(sent.get("client_secret"), "s3cret");
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "4/abcDEF");
  assert.equal(sent.get("code_verifier"), "verifier123");
  assert.equal(sent.get("client_id"), CLIENT_ID);
  assert.equal(sent.get("redirect_uri"), CALLBACK);

  assert.equal(d.logs.length, 2);
  const l = d.logs[1];
  assert.equal(l.event, "token");
  assert.equal(l.install, "https://org.example.com");
  assert.equal(l.status, 200);
  assert.equal(l.email, "evan@example.com");
  assert.equal(l.email_verified, true);
  assert.equal(l.hd, "example.com");
  assert.equal(l.outcome, "exchanged");
  assert.equal(l.ip, "198.51.100.7");
  assert.equal(l.code, d.logs[0].code, "the callback and token lines share the code's short hash");
  const dumped = JSON.stringify(d.logs);
  for (const secret of ["ya29", "1//refresh", "abcDEF", "verifier123", "s3cret", code]) assert.ok(!dumped.includes(secret), `${secret} must not be logged`);
});

test("a code sent to one address cannot be redeemed by another install", async () => {
  // The attack: someone starts a sign-in at org.example.com, rewrites the
  // return address in state to a server they run, and gets the victim to
  // open that Google link. The victim's code arrives there, sealed for it.
  const d = deps({ status: 200, body: JSON.stringify({ id_token: idToken({ email: "victim@example.com" }) }) });
  const code = await sealedCode("https://evil.example/auth/callback", d);
  const res = await handle(exchange({ code, return_url: "https://org.example.com/auth/callback" }), env(), d);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_grant", error_description: "code was issued for another install" });
  assert.equal(d.calls.length, 0, "nothing may reach Google");
  assert.equal(d.logs[1].outcome, "refused: code was issued for another install");
  assert.equal(d.logs[1].install, "https://org.example.com");
  assert.equal(d.logs[1].sealed_for, "https://evil.example");
});

test("token redeems only codes this relay sealed, within their time", async () => {
  const install = "https://org.example.com/auth/callback";
  const d = deps();
  const code = await sealedCode(install, d);
  const otherKey = deps();
  const sealedElsewhere = await (async () => {
    const res = await handle(new Request(`${CALLBACK}?code=x&state=${encodeURIComponent(stateFor(install))}`), env({ RELAY_SEAL_KEY: "another-relay-key-0123456789abcdefghijklmnop" }), otherKey);
    return new URL(res.headers.get("location")).searchParams.get("code");
  })();
  const tampered = code.slice(0, -2) + (code.endsWith("AA") ? "BB" : "AA");
  const cases = [
    ["4/abcDEF", "code was not issued by this relay"],
    ["k1.", "code was not issued by this relay"],
    ["k1.!!!", "code was not issued by this relay"],
    [tampered, "code was not issued by this relay"],
    [sealedElsewhere, "code was not issued by this relay"],
  ];
  for (const [c, why] of cases) {
    const res = await handle(exchange({ code: c, return_url: install }), env(), d);
    assert.equal(res.status, 400, c);
    assert.deepEqual(await res.json(), { error: "invalid_grant", error_description: why });
  }
  d.clock.t = T0 + 10 * 60 * 1000 + 1;
  const res = await handle(exchange({ code, return_url: install }), env(), d);
  assert.deepEqual(await res.json(), { error: "invalid_grant", error_description: "code has expired" });
  assert.equal(d.calls.length, 0);
});

test("token compares return_url as a URL, so case and a default port do not matter", async () => {
  const d = deps({ status: 200, body: JSON.stringify({ id_token: idToken({ email: "a@example.com" }) }) });
  const code = await sealedCode("https://org.example.com/auth/callback", d);
  const res = await handle(exchange({ code, return_url: "https://Org.Example.com:443/auth/callback" }), env(), d);
  assert.equal(res.status, 200);
});

test("token answers 502 when Google's success carries no id_token", async () => {
  const d = deps({ status: 200, body: JSON.stringify({ access_token: "ya29.secret", token_type: "Bearer" }) });
  const install = "https://org.example.com/auth/callback";
  const res = await handle(exchange({ code: await sealedCode(install, d), return_url: install }), env(), d);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "server_error");
  assert.ok(!JSON.stringify(d.logs).includes("ya29"));
  assert.equal(d.logs[1].outcome, "no id_token from google");
});

test("token returns Google's error status and body verbatim", async () => {
  const google = JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" });
  const d = deps({ status: 400, body: google });
  const install = "https://org.example.com/auth/callback";
  const res = await handle(exchange({ code: await sealedCode(install, d), return_url: install }), env(), d);
  assert.equal(res.status, 400);
  assert.equal(await res.text(), google);
  assert.equal(d.logs[1].outcome, "google error: invalid_grant");
  assert.equal(d.logs[1].email, undefined);
});

test("token refuses anything but a PKCE code exchange for the public client at the relay's callback", async () => {
  const good = { grant_type: "authorization_code", code: "x", code_verifier: "v", client_id: CLIENT_ID, redirect_uri: CALLBACK, return_url: "https://o.example/auth/callback" };
  const cases = [
    [{ ...good, grant_type: "refresh_token" }, "grant_type must be authorization_code"],
    [{ ...good, client_id: "other.apps.googleusercontent.com" }, "client_id is not the public client"],
    [{ ...good, redirect_uri: "https://evil.example/auth/callback" }, "redirect_uri is not the relay's callback"],
    [{ ...good, client_secret: "mine" }, "client_secret is not accepted"],
    [{ ...good, code: "" }, "code is required"],
    [{ ...good, code_verifier: "" }, "code_verifier is required"],
    [{ ...good, return_url: "" }, "return_url is required"],
  ];
  for (const [fields, why] of cases) {
    assert.equal(refuseExchange(new URLSearchParams(fields), env()), why);
    const d = deps();
    const res = await handle(
      new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }),
      env(),
      d,
    );
    assert.equal(res.status, 400, why);
    assert.deepEqual(await res.json(), { error: "invalid_request", error_description: why });
    assert.equal(d.calls.length, 0, "nothing may reach Google");
    assert.equal(d.logs[0].outcome, `refused: ${why}`);
  }
  assert.equal(refuseExchange(new URLSearchParams(good), env()), "");
});

test("token wants a form body, a POST, and both configured secrets", async () => {
  const d = deps();
  let res = await handle(new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env(), d);
  assert.equal(res.status, 400);
  res = await handle(new Request("https://kivali.ai/oauth/google/token", { method: "GET" }), env(), d);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  res = await handle(
    new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" }),
    env({ GOOGLE_CLIENT_SECRET: undefined }),
    d,
  );
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "server_error");
  res = await handle(
    new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" }),
    env({ RELAY_SEAL_KEY: undefined }),
    d,
  );
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "server_error", error_description: "the relay has no sealing key" });
  res = await handle(
    new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=" + "x".repeat(9000) }),
    env(),
    d,
  );
  assert.equal(res.status, 413);
  assert.equal(d.calls.length, 0);
});

test("other paths are not found and the rate limiter is honoured", async () => {
  let res = await handle(new Request("https://kivali.ai/oauth/google/other"), env(), deps());
  assert.equal(res.status, 404);
  res = await handle(new Request("https://kivali.ai/oauth/google/callback?code=x&state=" + stateFor("https://o.example/auth/callback")), env({ LIMITER: { limit: async () => ({ success: false }) } }), deps());
  assert.equal(res.status, 429);
  res = await handle(new Request("https://kivali.ai/oauth/google/callback?code=x&state=" + stateFor("https://o.example/auth/callback")), env({ LIMITER: { limit: async () => ({ success: true }) } }), deps());
  assert.equal(res.status, 302);
});

test("idTokenOnly keeps the id_token and its framing and drops everything else", () => {
  assert.deepEqual(idTokenOnly(JSON.stringify({ access_token: "a", refresh_token: "r", scope: "s", id_token: "i", token_type: "Bearer", expires_in: 1 })), { id_token: "i", token_type: "Bearer", expires_in: 1 });
  assert.equal(idTokenOnly(JSON.stringify({ access_token: "a" })), null);
  assert.equal(idTokenOnly(JSON.stringify({ id_token: "" })), null);
  assert.equal(idTokenOnly("not json"), null);
  assert.equal(idTokenOnly("null"), null);
});

test("whoSignedIn reads the id_token claims and tolerates garbage", () => {
  assert.deepEqual(whoSignedIn(200, "not json"), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ access_token: "x" })), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ id_token: "a.b" })), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ id_token: "a.!!.c" })), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ id_token: idToken({ email: "a@b.c", email_verified: "true" }) })), { email: "a@b.c", emailVerified: true, hd: undefined });
  assert.deepEqual(whoSignedIn(401, JSON.stringify({ error: "invalid_client" })), { error: "invalid_client" });
});
