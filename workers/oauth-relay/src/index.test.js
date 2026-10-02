import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, installFromState, refuseExchange, whoSignedIn } from "./index.js";

const CLIENT_ID = "508969299515-4eh9cdufhb3ntpc3panbku2s1dka8as4.apps.googleusercontent.com";
const CALLBACK = "https://kivali.ai/oauth/google/callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function env(extra = {}) {
  return { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "s3cret", CALLBACK_URL: CALLBACK, GOOGLE_TOKEN_URL: TOKEN_URL, ...extra };
}

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stateFor(installURL, nonce = "n0nce") {
  return `${nonce}.${b64url(installURL)}`;
}

// A fake Google token endpoint plus a log sink, returned as deps.
function deps(upstream = { status: 200, body: "{}" }) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
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

test("callback bounces the browser to the install named in state with the query unchanged", async () => {
  const d = deps();
  const install = "https://org.example.com/auth/callback";
  const q = `?state=${encodeURIComponent(stateFor(install))}&code=4%2FabcDEF&scope=openid+email&authuser=0&prompt=consent`;
  const res = await handle(new Request(`${CALLBACK}${q}`, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env(), d);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), install + q);
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
  assert.equal(res.headers.get("location"), install + q);
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

test("callback takes GET only", async () => {
  const res = await handle(new Request(`${CALLBACK}?code=x&state=${stateFor("https://o.example/auth/callback")}`, { method: "POST" }), env(), deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("token adds the secret, forwards to Google and returns the answer verbatim, logging who signed in", async () => {
  const google = JSON.stringify({
    access_token: "ya29.secret",
    id_token: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, email: "evan@example.com", email_verified: true, hd: "example.com", nonce: "n0nce" }),
    token_type: "Bearer",
    expires_in: 3599,
  });
  const d = deps({ status: 200, body: google });
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: "4/abcDEF",
    code_verifier: "verifier123",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
  });
  const res = await handle(
    new Request("https://kivali.ai/oauth/google/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.7" },
      body: body.toString(),
    }),
    env(),
    d,
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), google);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "no-store");

  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, TOKEN_URL);
  assert.equal(d.calls[0].init.method, "POST");
  const sent = new URLSearchParams(d.calls[0].init.body);
  assert.equal(sent.get("client_secret"), "s3cret");
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "4/abcDEF");
  assert.equal(sent.get("code_verifier"), "verifier123");
  assert.equal(sent.get("client_id"), CLIENT_ID);
  assert.equal(sent.get("redirect_uri"), CALLBACK);

  assert.equal(d.logs.length, 1);
  const l = d.logs[0];
  assert.equal(l.event, "token");
  assert.equal(l.status, 200);
  assert.equal(l.email, "evan@example.com");
  assert.equal(l.email_verified, true);
  assert.equal(l.hd, "example.com");
  assert.equal(l.outcome, "exchanged");
  assert.equal(l.ip, "198.51.100.7");
  assert.match(l.code, /^[0-9a-f]{8}$/);
  const dumped = JSON.stringify(d.logs);
  assert.ok(!dumped.includes("ya29") && !dumped.includes("abcDEF") && !dumped.includes("verifier123") && !dumped.includes("s3cret"));
});

test("the callback and token log lines share the code's short hash", async () => {
  const d = deps({ status: 200, body: "{}" });
  const install = "https://org.example.com/auth/callback";
  await handle(new Request(`${CALLBACK}?code=4%2FabcDEF&state=${encodeURIComponent(stateFor(install))}`), env(), d);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: "4/abcDEF", code_verifier: "v", client_id: CLIENT_ID, redirect_uri: CALLBACK });
  await handle(new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }), env(), d);
  assert.equal(d.logs.length, 2);
  assert.equal(d.logs[0].code, d.logs[1].code);
});

test("token returns Google's error status and body verbatim", async () => {
  const google = JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" });
  const d = deps({ status: 400, body: google });
  const body = new URLSearchParams({ grant_type: "authorization_code", code: "x", code_verifier: "v", client_id: CLIENT_ID, redirect_uri: CALLBACK });
  const res = await handle(new Request("https://kivali.ai/oauth/google/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }), env(), d);
  assert.equal(res.status, 400);
  assert.equal(await res.text(), google);
  assert.equal(d.logs[0].outcome, "google error: invalid_grant");
  assert.equal(d.logs[0].email, undefined);
});

test("token refuses anything but a PKCE code exchange for the public client at the relay's callback", async () => {
  const good = { grant_type: "authorization_code", code: "x", code_verifier: "v", client_id: CLIENT_ID, redirect_uri: CALLBACK };
  const cases = [
    [{ ...good, grant_type: "refresh_token" }, "grant_type must be authorization_code"],
    [{ ...good, client_id: "other.apps.googleusercontent.com" }, "client_id is not the public client"],
    [{ ...good, redirect_uri: "https://evil.example/auth/callback" }, "redirect_uri is not the relay's callback"],
    [{ ...good, client_secret: "mine" }, "client_secret is not accepted"],
    [{ ...good, code: "" }, "code is required"],
    [{ ...good, code_verifier: "" }, "code_verifier is required"],
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

test("token wants a form body, a POST, and a configured secret", async () => {
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

test("whoSignedIn reads the id_token claims and tolerates garbage", () => {
  assert.deepEqual(whoSignedIn(200, "not json"), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ access_token: "x" })), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ id_token: "a.b" })), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ id_token: "a.!!.c" })), {});
  assert.deepEqual(whoSignedIn(200, JSON.stringify({ id_token: idToken({ email: "a@b.c", email_verified: "true" }) })), { email: "a@b.c", emailVerified: true, hd: undefined });
  assert.deepEqual(whoSignedIn(401, JSON.stringify({ error: "invalid_client" })), { error: "invalid_client" });
});
