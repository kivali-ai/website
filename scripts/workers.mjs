#!/usr/bin/env node
// Finds the Workers in this repo and works out which ones a change touches.
// A Worker is any directory under workers/ with a wrangler.jsonc, wrangler.json or wrangler.toml.
//
//   node scripts/workers.mjs list                  every Worker, as a JSON array of directories
//   node scripts/workers.mjs changed <base> [head] Workers touched between two commits (JSON array)
//   node scripts/workers.mjs routes                print which Worker claims which route
//   node scripts/workers.mjs check                 lint routes, then `wrangler deploy --dry-run` every Worker
//
// A change outside workers/ (package.json, the lockfile, scripts/, .github/ and so on) can affect
// every Worker, so it selects all of them. Docs-only changes select none.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
const IGNORED = [/^README\.md$/, /^docs\//, /^\.gitignore$/, /^\.editorconfig$/, /^LICENSE/];

function listWorkers() {
  const dir = join(ROOT, "workers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && CONFIGS.some((c) => existsSync(join(dir, d.name, c))))
    .map((d) => `workers/${d.name}`)
    .sort();
}

function changedWorkers(base, head = "HEAD") {
  const all = listWorkers();
  // No usable base (first push to a branch, force-push, shallow history): deploy everything.
  if (!base || /^0+$/.test(base)) return all;
  let files;
  try {
    files = execFileSync("git", ["diff", "--name-only", base, head], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return all;
  }
  const hit = new Set();
  for (const f of files) {
    const m = f.match(/^workers\/([^/]+)\//);
    if (m) {
      if (all.includes(`workers/${m[1]}`)) hit.add(`workers/${m[1]}`);
    } else if (!IGNORED.some((re) => re.test(f))) {
      return all;
    }
  }
  return all.filter((w) => hit.has(w));
}

// Every route and Custom Domain each Worker claims, read with wrangler's own config parser.
// wrangler is imported here rather than at the top so `list` and `changed` run without `npm ci`.
async function collectRoutes() {
  const { unstable_readConfig: readConfig } = await import("wrangler");
  return listWorkers().flatMap((dir) => {
    const file = CONFIGS.map((c) => join(ROOT, dir, c)).find(existsSync);
    const config = readConfig({ config: file });
    const routes = [...(config.routes ?? []), ...(config.route ? [config.route] : [])];
    return routes.map((r) => {
      const pattern = (typeof r === "string" ? r : r.pattern).trim().replace(/^https?:\/\//, "").toLowerCase();
      return { dir, worker: config.name, pattern, customDomain: typeof r === "object" && r.custom_domain === true };
    });
  });
}

// Overlapping routes are allowed; the most specific pattern wins at Cloudflare. Two things are not:
//   1. the same pattern claimed twice, which Cloudflare rejects at deploy time or which hides a mistake;
//   2. a route covering every path of a Custom Domain host (kivali.ai/*, *kivali.ai/*), which would
//      silently take over the Worker that owns that domain (e.g. the whole website).
async function lintRoutes() {
  const routes = await collectRoutes();
  const errors = [];

  const byPattern = Map.groupBy(routes, (r) => r.pattern);
  for (const [pattern, claims] of byPattern) {
    if (claims.length > 1) {
      errors.push(`"${pattern}" is claimed more than once: ${claims.map((c) => c.dir).join(", ")}`);
    }
  }

  const domains = routes.filter((r) => r.customDomain);
  for (const r of routes.filter((r) => !r.customDomain)) {
    const slash = r.pattern.indexOf("/");
    const host = slash === -1 ? r.pattern : r.pattern.slice(0, slash);
    const path = slash === -1 ? "" : r.pattern.slice(slash);
    if (path !== "/*") continue;
    for (const d of domains) {
      const matches = host.startsWith("*") ? d.pattern.endsWith(host.slice(1)) : d.pattern === host;
      if (matches && d.dir !== r.dir) {
        errors.push(`${r.dir} claims "${r.pattern}", which would take over all of ${d.pattern} (Custom Domain of ${d.dir})`);
      }
    }
  }

  if (errors.length) {
    console.error(`✘ route conflicts:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`✓ ${routes.length} route(s) across ${new Set(routes.map((r) => r.dir)).size} worker(s), no conflicts`);
}

async function printRoutes() {
  for (const r of await collectRoutes()) {
    console.log(`${r.pattern.padEnd(40)} ${r.customDomain ? "custom domain" : "route        "}  ${r.dir}`);
  }
}

async function check() {
  await lintRoutes();
  const workers = listWorkers();
  for (const w of workers) {
    console.log(`\n▸ ${w}`);
    execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(ROOT, ".wrangler-dry-run", w)], {
      cwd: join(ROOT, w),
      stdio: "inherit",
    });
  }
  console.log(`\n✓ ${workers.length} worker(s) built`);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "list":
    console.log(JSON.stringify(listWorkers()));
    break;
  case "changed":
    console.log(JSON.stringify(changedWorkers(...args)));
    break;
  case "routes":
    await printRoutes();
    break;
  case "check":
    await check();
    break;
  default:
    console.error("usage: workers.mjs list | changed <base> [head] | routes | check");
    process.exit(2);
}
