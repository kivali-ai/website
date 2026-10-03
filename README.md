# kivali.ai

The Kivali website and the Cloudflare Workers that run on its domain.

```
workers/
  site/                 kivali.ai: static home, /privacy, /terms (assets-only Worker, no build step)
    wrangler.jsonc
    public/             served as-is; _headers sets security and cache headers
  oauth-relay/          kivali.ai/oauth/google/*: the sign-in relay for Kivali's public Google client
    wrangler.jsonc
    src/index.js        two routes, no dependencies; src/index.test.js runs with `node --test`
scripts/workers.mjs     finds Workers, works out which ones a change touches, lints their routes
.github/workflows/
  pull-request.yml      PRs into main: check + per-PR preview URLs
  deploy.yml            pushes to main: check + deploy to production
```

## Local development

```sh
npm ci
npm run dev      # http://localhost:8787
npm test         # the Workers' unit tests (node --test)
npm run check    # html-validate + tests + `wrangler deploy --dry-run` for every Worker
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

### Secrets

A Worker that needs secrets lists their names in `workers/<name>/secrets`, one per line (`#` comments allowed):

```
# the API key for ...
SOME_API_KEY
```

Add each value under the same name to this repository's Actions secrets (Settings → Secrets and variables → Actions). After every deploy of that Worker, the deploy job puts the declared secrets on it with `wrangler secret bulk`, and fails if one is missing from the repository. To rotate a secret, update it in the repository and redeploy (Actions → Deploy → *Run workflow*). `npm run check` validates the file's names. Nothing is special-cased per Worker: the job reads the file. Previews from pull requests get no secrets.

## The sign-in relay (`workers/oauth-relay`)

Every Kivali install signs people in with Google through one shared OAuth client whose
id is baked into the Kivali server. Google issues a secret for that client and requires
it at its token endpoint even with PKCE, so the secret lives in this Worker and nowhere
else. The Worker serves two routes under `https://kivali.ai/oauth/google`, the base every
Kivali build carries:

| Route | Who calls it | What it does |
| --- | --- | --- |
| `GET /oauth/google/callback` | the browser, sent by Google | the redirect URI registered on the client. Decodes the install's own callback URL from `state` (`<nonce>.<base64url(url)>`), checks it is an `/auth/callback` over https (http only on loopback), and answers a 302 there with Google's query string unchanged. |
| `POST /oauth/google/token` | the install, server to server | accepts only `grant_type=authorization_code` for the public client at the relay's own callback, with `code` and `code_verifier`; adds the secret, forwards to Google and returns Google's status and JSON verbatim. |

The install trusts only Google's signed `id_token` (checked against Google's keys, with
the nonce it sent), never this relay, so the relay can neither sign anyone in nor learn a
session. It stores nothing. The full contract is `docs/AUTH.md` in the kivali repo.

**What it logs.** One JSON line per step, in Workers Logs (the Worker's *Logs* tab): the
install (`https://org.example.com`, `http://127.0.0.1:8080`), the Google account that
signed in (`email`, `email_verified`, `hd` from the `id_token`), the outcome, the client
IP, and a short hash of the code that ties a callback line to its token line. Codes,
verifiers and tokens are never logged.

**Rate limit.** 60 requests a minute per IP on both routes, through Cloudflare's rate
limiting binding (configured under `unsafe` while it is in beta; the code runs without it).

### One-time setup

1. **Google Cloud console**, the Kivali project's OAuth client (a *Web application*
   client): add `https://kivali.ai/oauth/google/callback` as an authorized redirect URI.
   No JavaScript origins are needed. While the consent screen is in *Testing*, only the
   listed test users can sign in; publish it for everyone else.
2. **The secret.** Add the client secret as `GOOGLE_CLIENT_SECRET` in this repository's
   Actions secrets; the Worker declares that name in `workers/oauth-relay/secrets`, so the
   deploy job puts it on the Worker (see "Secrets" above). Until it is on the Worker, the
   token route answers 500 with "the relay has no client secret".
3. **Deploy** by merging to `main` like any Worker. Then check:

```sh
curl -si 'https://kivali.ai/oauth/google/callback?code=x&state=n.aHR0cHM6Ly9leGFtcGxlLmNvbS9hdXRoL2NhbGxiYWNr'
# 302 with Location: https://example.com/auth/callback?code=x&state=...
curl -si -X POST https://kivali.ai/oauth/google/token -d grant_type=refresh_token
# 400 {"error":"invalid_request","error_description":"grant_type must be authorization_code"}
```

A real sign-in from a Kivali install then shows up as two log lines, and the install
signs the person in. If Google answers `redirect_uri_mismatch` on the consent page, step 1
is missing.

## License

Apache License 2.0. See [LICENSE](LICENSE).
