# kivali.ai

The Kivali website and the Cloudflare Workers that run on its domain.

```
workers/
  site/                 kivali.ai: static home, /privacy, /terms (assets-only Worker, no build step)
    wrangler.jsonc
    public/             served as-is; _headers sets security and cache headers
scripts/workers.mjs     finds Workers, works out which ones a change touches, lints their routes
.github/workflows/
  pull-request.yml      PRs into main: check + per-PR preview URLs
  deploy.yml            pushes to main: check + deploy to production
```

## Local development

```sh
npm ci
npm run dev      # http://localhost:8787
npm run check    # html-validate + `wrangler deploy --dry-run` for every Worker
```

The pages are plain HTML and CSS with no client-side JavaScript. Edit `workers/site/public/` directly.
`/privacy` serves `privacy.html` (the `.html` URL redirects to the clean one) and unknown paths get `404.html`.

## Branches and deploys

`main` is production. Work on a branch and open a PR into `main`.

- **Pull request** (`pull-request.yml`): runs `npm run check`, then uploads a *preview version* of each Worker the PR changes and comments its URL on the PR (`https://pr-<n>-<worker>.<subdomain>.workers.dev`). Previews never take production traffic. PRs from forks get the check but no preview, because secrets aren't shared with them.
- **Merge to main** (`deploy.yml`): runs the check again, then `wrangler deploy` for each Worker the push changed. Changes outside `workers/` (lockfile, scripts, workflows) redeploy every Worker; README-only changes deploy nothing. Deploys are serialized and never cancelled mid-flight.
- **Manual redeploy**: Actions → Deploy → *Run workflow* deploys every Worker from `main`.
- **Rollback**: `npx wrangler rollback` in the Worker's directory, or Workers & Pages → the Worker → Deployments in the dashboard. Then revert the commit on `main`.

## One-time setup

1. **Cloudflare API token.** Dashboard → My Profile → API Tokens → *Create Token* → the **Edit Cloudflare Workers** template. Scope it to the Kivali account and the `kivali.ai` zone. It needs Workers Scripts: Edit (account), and Workers Routes: Edit plus DNS: Edit on the zone, because the site creates its Custom Domain record.
2. **GitHub secrets.** Repo → Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the account ID is on the Workers & Pages overview page).
3. **GitHub environment.** Settings → Environments → create `production`. Optionally add required reviewers or restrict it to `main`. The deploy job runs in this environment, so its history shows on the repo page.
4. **Branch protection.** Protect `main`: require a PR and require the **Check** status check to pass.
5. **workers.dev subdomain.** PR previews live on `*.workers.dev`, so the account needs a workers.dev subdomain (Workers & Pages → Settings). Preview URLs are public; put them behind Cloudflare Access if that matters.
6. **First deploy.** Previews only work for a Worker that has been deployed once, so the first push to `main` (or a manual run of Deploy) creates `kivali-site` and attaches `kivali.ai` to it. If `kivali.ai` already has a DNS record pointing somewhere else, remove it first or the Custom Domain can't be attached.

## Adding another Worker

Create `workers/<name>/` with its own `wrangler.jsonc` (and `src/`, `package.json` etc. as needed). The pipelines pick it up automatically: no workflow changes needed. The root `package.json` declares `workers/*` as npm workspaces, so a Worker's own dependencies install with the root `npm ci` (add them with `npm install <pkg> -w workers/<name>`).

To serve it on a path of the site, give it a route on the zone instead of a Custom Domain:

```jsonc
{
  "name": "kivali-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "routes": [{ "pattern": "kivali.ai/api/*", "zone_name": "kivali.ai" }],
  "workers_dev": false,
  "preview_urls": true
}
```

The site owns `kivali.ai` as a Custom Domain, and Cloudflare runs Workers on routes before the Custom Domain, so `kivali.ai/api/*` goes to `kivali-api` and everything else falls through to the site.

`npm run routes` prints which Worker claims which route. `npm run check` (and so every PR) lints them:

- **Overlaps are allowed.** `kivali.ai/api/*` and `kivali.ai/api/admin/*` can belong to different Workers; the more specific pattern wins.
- **Exact duplicates fail.** Two Workers can't claim the same pattern.
- **Whole-domain wildcards fail.** A route like `kivali.ai/*` or `*kivali.ai/*` would take every request away from the Worker that owns `kivali.ai` as a Custom Domain, i.e. the whole website.

If a Worker needs a build step (TypeScript, bundling), `wrangler deploy` already bundles `main` with esbuild. Anything beyond that goes in a `build` field in its `wrangler.jsonc` (`"build": { "command": "npm run build" }`), which wrangler runs for both `--dry-run` and real deploys.

## License

Apache License 2.0. See [LICENSE](LICENSE).
