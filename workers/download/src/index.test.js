import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, installerUrl } from "./index.js";

const FEED_URL = "https://github.com/kivali-ai/kivali/releases/latest/download/latest.json";
const RELEASES_URL = "https://github.com/kivali-ai/kivali/releases/latest";
const RELEASE = "https://github.com/kivali-ai/kivali/releases/download/v1.1.1";
const DMG = `${RELEASE}/Kivali_1.1.1_aarch64.dmg`;
const EXE = `${RELEASE}/Kivali_1.1.1_x64-setup.exe`;
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const env = { FEED_URL, RELEASES_URL };
const feed = {
  version: "1.1.1",
  platforms: {
    "darwin-aarch64": { url: `${RELEASE}/Kivali.app.tar.gz`, signature: "sig" },
    "windows-x86_64": { url: EXE, signature: "sig" },
  },
};

// A fake GitHub answering the feed URL, and an empty edge cache, returned as deps with the fetches made.
function deps(upstream = { status: 200, body: JSON.stringify(feed) }) {
  const calls = [];
  const store = new Map();
  return {
    calls,
    store,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (upstream instanceof Error) throw upstream;
      return new Response(upstream.body, { status: upstream.status });
    },
    cache: {
      match: async (key) => store.get(key)?.clone(),
      put: async (key, response) => {
        store.set(key, response);
      },
    },
    waitUntil: () => {},
  };
}

function request(path, userAgent = "", method = "GET") {
  return new Request(`https://kivali.ai${path}`, { method, headers: userAgent ? { "user-agent": userAgent } : {} });
}

async function location(path, d = deps(), userAgent = "", method = "GET") {
  const res = await handle(request(path, userAgent, method), env, d);
  assert.equal(res.status, 302, `${method} ${path}: ${res.status}`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  return res.headers.get("location");
}

test("/download/macos sends the browser to the latest release's disk image", async () => {
  assert.equal(await location("/download/macos"), DMG);
});

test("/download/windows sends the browser to the latest release's installer", async () => {
  assert.equal(await location("/download/windows"), EXE);
});

test("/download picks the installer from the browser's platform, or the release page", async () => {
  assert.equal(await location("/download", deps(), MAC), DMG);
  assert.equal(await location("/download", deps(), WINDOWS), EXE);
  assert.equal(await location("/download", deps(), LINUX), RELEASES_URL);
  assert.equal(await location("/download", deps(), IPHONE), RELEASES_URL);
  assert.equal(await location("/download", deps(), ""), RELEASES_URL);
});

test("a trailing slash and HEAD are accepted", async () => {
  assert.equal(await location("/download/", deps(), MAC), DMG);
  assert.equal(await location("/download/windows/"), EXE);
  assert.equal(await location("/download/macos", deps(), "", "HEAD"), DMG);
});

test("any other path is not found; any other method is not allowed", async () => {
  for (const path of ["/download/linux", "/downloads", "/download/macos/x", "/"]) {
    assert.equal((await handle(request(path), env, deps())).status, 404, path);
  }
  const res = await handle(request("/download/macos", "", "POST"), env, deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("the feed is fetched once, following GitHub's redirect, then served from the edge cache", async () => {
  const d = deps();
  assert.equal(await location("/download/macos", d), DMG);
  assert.equal(await location("/download/windows", d), EXE);
  assert.equal(await location("/download", d, WINDOWS), EXE);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, FEED_URL);
  assert.equal(d.calls[0].init.redirect, "follow");
  const cached = d.store.get(FEED_URL);
  assert.equal(cached.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(await cached.clone().json(), feed);
});

test("when the feed cannot be read, the browser gets the release page and nothing is cached", async () => {
  for (const upstream of [new Error("connection reset"), { status: 404, body: "Not Found" }, { status: 200, body: "<html>" }, { status: 200, body: "null" }]) {
    const d = deps(upstream);
    assert.equal(await location("/download/macos", d), RELEASES_URL);
    assert.equal(await location("/download/windows", d), RELEASES_URL);
    assert.equal(d.store.size, 0);
    assert.equal(d.calls.length, 2);
  }
});

test("a feed that lacks the platform or its version sends the browser to the release page", async () => {
  const noMac = { ...feed, platforms: { "windows-x86_64": feed.platforms["windows-x86_64"] } };
  assert.equal(await location("/download/macos", deps({ status: 200, body: JSON.stringify(noMac) })), RELEASES_URL);
  assert.equal(await location("/download/windows", deps({ status: 200, body: JSON.stringify(noMac) })), EXE);
  const noVersion = { platforms: feed.platforms };
  assert.equal(await location("/download/macos", deps({ status: 200, body: JSON.stringify(noVersion) })), RELEASES_URL);
});

test("only an https URL on the feed's host is a destination", () => {
  assert.equal(installerUrl(feed, "macos", FEED_URL), DMG);
  assert.equal(installerUrl(feed, "windows", FEED_URL), EXE);
  const elsewhere = { ...feed, platforms: { "windows-x86_64": { url: "https://example.com/evil.exe" } } };
  assert.equal(installerUrl(elsewhere, "windows", FEED_URL), null);
  const plain = { ...feed, platforms: { "windows-x86_64": { url: "http://github.com/kivali-ai/kivali/releases/download/v1.1.1/x.exe" } } };
  assert.equal(installerUrl(plain, "windows", FEED_URL), null);
  const traversal = { ...feed, version: "../../../evil" };
  assert.equal(installerUrl(traversal, "macos", FEED_URL), null);
  assert.equal(installerUrl({ ...feed, platforms: { "windows-x86_64": { url: "not a url" } } }, "windows", FEED_URL), null);
  assert.equal(installerUrl(null, "macos", FEED_URL), null);
});
