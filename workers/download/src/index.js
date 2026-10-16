// kivali.ai/download: the latest Kivali Desktop installer, one click away.
//
//   GET /download/macos     302 to the macOS disk image (Apple silicon)
//   GET /download/windows   302 to the Windows installer (x64)
//   GET /download           302 to whichever of those fits the browser's
//                           platform; any other platform gets the release page
//
// Releases live on GitHub and their installer names carry the version, so
// no fixed GitHub URL means "the latest disk image". Each release does
// publish one file at a fixed URL: latest.json, the desktop app's update
// feed (scripts/latest-json.sh in the kivali repo), which names the version
// and the Windows installer and sits in the release beside the macOS disk
// image. This Worker reads that feed, keeps it in the edge cache for a few
// minutes and answers with a redirect. When the feed cannot be read, the
// browser is sent to the release page instead, so a download button never
// dead-ends.
//
// It stores nothing and logs nothing about the visitor.

const FEED_TTL_SECONDS = 300;
const PLATFORMS = { macos: "darwin-aarch64", windows: "windows-x86_64" };

export default {
  fetch(request, env, ctx) {
    return handle(request, env, {
      fetch: globalThis.fetch.bind(globalThis),
      cache: caches.default,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
};

/**
 * @param {Request} request
 * @param {{FEED_URL: string, RELEASES_URL: string}} env
 * @param {{fetch: typeof fetch, cache: Cache, waitUntil: (promise: Promise<unknown>) => void}} deps
 */
export async function handle(request, env, deps) {
  const platform = platformFor(new URL(request.url).pathname, request.headers.get("user-agent") ?? "");
  if (platform === undefined) return text(404, "not found");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "method not allowed", { allow: "GET, HEAD" });
  }
  if (platform === null) return redirect(env.RELEASES_URL);
  const feed = await latestFeed(env.FEED_URL, deps);
  return redirect(installerUrl(feed, platform, env.FEED_URL) ?? env.RELEASES_URL);
}

// The path names the platform. /download alone leaves it to the browser's
// User-Agent: macOS and Windows get their installer (null means neither:
// Linux, phones, crawlers, which get the release page). Any other path is
// undefined: not found.
export function platformFor(pathname, userAgent) {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/download/macos") return "macos";
  if (path === "/download/windows") return "windows";
  if (path !== "/download") return undefined;
  if (/Windows NT/.test(userAgent)) return "windows";
  if (/Mac OS X/.test(userAgent) && !/iPhone|iPad/.test(userAgent)) return "macos";
  return null;
}

// The feed names the Windows installer outright. For macOS it names the
// updater's archive (Kivali.app.tar.gz); the disk image people install
// from sits beside it as Kivali_<version>_aarch64.dmg. Only an https URL
// on the feed's own host is ever a destination, so a bad feed cannot turn
// this Worker into an open redirect.
export function installerUrl(feed, platform, feedUrl) {
  const entry = feed?.platforms?.[PLATFORMS[platform]];
  const version = feed?.version;
  if (typeof entry?.url !== "string" || typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version)) {
    return null;
  }
  let target;
  try {
    target = platform === "macos" ? new URL(`Kivali_${version}_aarch64.dmg`, entry.url) : new URL(entry.url);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.host !== new URL(feedUrl).host) return null;
  return target.href;
}

// The feed, parsed: from the edge cache, or fetched from GitHub (which
// answers the fixed URL with a redirect to the asset, which fetch follows)
// and kept for FEED_TTL_SECONDS. Only a feed that parses is cached, so a
// bad answer is retried on the next request.
async function latestFeed(feedUrl, deps) {
  const hit = await deps.cache.match(feedUrl);
  if (hit) return parseFeed(await hit.text());
  let body;
  try {
    const response = await deps.fetch(feedUrl, { redirect: "follow", headers: { "user-agent": "kivali.ai/download" } });
    if (!response.ok) return null;
    body = await response.text();
  } catch {
    return null;
  }
  const feed = parseFeed(body);
  if (feed) {
    const headers = { "content-type": "application/json", "cache-control": `public, max-age=${FEED_TTL_SECONDS}` };
    deps.waitUntil(deps.cache.put(feedUrl, new Response(body, { headers })));
  }
  return feed;
}

function parseFeed(body) {
  try {
    const feed = JSON.parse(body);
    return feed && typeof feed === "object" ? feed : null;
  } catch {
    return null;
  }
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function text(status, body, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}
