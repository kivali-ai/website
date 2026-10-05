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
  pull-request.yml      PRs into main: check (no secrets)
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

- **Pull request** (`pull-request.yml`): runs `npm run check` (HTML lint, tests, a dry-run build of every Worker). It gets no secrets. There are no preview deployments: a pull request runs its own copy of the workflow files, so any secret a PR job can read, any branch can print, and a preview version of a Worker runs with that Worker's real secrets. Try changes locally with `npm run dev` (or `npx wrangler dev` in a Worker's directory).
- **Merge to main** (`deploy.yml`): runs the check again, then `wrangler deploy` for each Worker the push changed. Changes outside `workers/` (lockfile, scripts, workflows) redeploy every Worker; README-only changes deploy nothing. Deploys are serialized and never cancelled mid-flight.
- **Manual redeploy**: Actions → Deploy → *Run workflow* deploys every Worker from `main`.
- **Rollback**: `npx wrangler rollback` in the Worker's directory, or Workers & Pages → the Worker → Deployments in the dashboard. Then revert the commit on `main`.

## One-time setup

1. **Cloudflare API token.** Dashboard → My Profile → API Tokens → *Create Token* → the **Edit Cloudflare Workers** template. Scope it to the Kivali account and the `kivali.ai` zone. It needs Workers Scripts: Edit (account), and Workers Routes: Edit plus DNS: Edit on the zone, because the site creates its Custom Domain record.
2. **GitHub environment.** Settings → Environments → create `production`, and under *Deployment branches and tags* allow only `main`. Optionally add required reviewers.
3. **Secrets, in the environment only.** Settings → Environments → `production` → *Environment secrets*: add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (on the Workers & Pages overview page) and every Worker secret (below). Keep *repository* secrets empty: a repository secret is readable by any branch's workflow, an environment secret only by jobs that environment admits, i.e. the deploy job on `main`.
4. **Branch protection.** Protect `main`: require a PR and require the **Check** status check to pass.
5. **First deploy.** The first push to `main` (or a manual run of Deploy) creates `kivali-site` and attaches `kivali.ai` to it. If `kivali.ai` already has a DNS record pointing somewhere else, remove it first or the Custom Domain can't be attached.

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
  "preview_urls": false
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

Add each value under the same name to the `production` environment's secrets (Settings → Environments → `production`), never as a repository secret. After every deploy of that Worker, the deploy job puts the declared secrets on it with `wrangler secret bulk`, and fails if one is missing. To rotate a secret, update it in the environment and redeploy (Actions → Deploy → *Run workflow*). `npm run check` validates the file's names. Nothing is special-cased per Worker: the job reads the file.

## The sign-in relay (`workers/oauth-relay`)

Every Kivali install signs people in with Google through one shared OAuth client whose
id is baked into the Kivali server. Google issues a secret for that client and requires
it at its token endpoint even with PKCE, so the secret lives in this Worker and nowhere
else. The Worker serves two routes under `https://kivali.ai/oauth/google`, the base every
Kivali build carries:

| Route | Who calls it | What it does |
| --- | --- | --- |
| `GET /oauth/google/callback` | the browser, sent by Google | the redirect URI registered on the client. Decodes the install's own callback URL from `state` (`<nonce>.<base64url(url)>`), checks it is an `/auth/callback` over https (http only on loopback), and answers a 302 there with Google's query string, its `code` replaced by the code *sealed* for that install. |
| `POST /oauth/google/token` | the install, server to server | accepts only `grant_type=authorization_code` for the public client at the relay's own callback, with the sealed `code`, `code_verifier` and the install's own callback URL as `return_url`; opens the code, refuses it unless it was sealed for that `return_url` in the last ten minutes, adds the secret and forwards it to Google. Returns Google's error verbatim, or on success only the `id_token` (with `token_type` and `expires_in`): no access or refresh token ever leaves the relay. |

The install trusts only Google's signed `id_token` (checked against Google's keys, with
the nonce it sent), never this relay, so the relay can neither sign anyone in nor learn a
session. It stores nothing. The full contract is `docs/AUTH.md` in the kivali repo.

**Why codes are sealed.** `state` is whatever the browser brought, so anyone can put any
address in it. Without sealing, an attacker could start a sign-in at an install, change
the return address in that Google link to a server they run, and get someone allowed on
the install to open it: the victim's code would arrive at the attacker's server, and the
attacker, who holds that sign-in's cookie, PKCE verifier and nonce, could redeem it at the
install and be signed in as the victim. Now the browser only ever carries
`k1.<AES-GCM(code, install callback URL, expiry)>` under `RELAY_SEAL_KEY`, which only this
Worker holds, and the token route redeems it only for the install it was sent to. A code
lured to another address is useless at every other install.

**What it logs.** One JSON line per step, in Workers Logs (the Worker's *Logs* tab): the
install (`https://org.example.com`, `http://127.0.0.1:8080`), the Google account that
signed in (`email`, `email_verified`, `hd` from the `id_token`), the outcome, the client
IP, and a short hash of the code that ties a callback line to its token line. Codes,
verifiers and tokens are never logged.

Only a `token` line with `"outcome":"exchanged"` records a sign-in. Its `email` comes from
the answer the relay itself got from Google, and its `install` from the sealed code, which
only the relay can write. A `callback` line records only that some browser fetched the
callback URL: anyone can request it with any `state` and `error`, so its fields are
whatever the request said.

**Rate limit.** 60 requests a minute per IP on both routes, through Cloudflare's rate
limiting binding (configured under `unsafe` while it is in beta; the code runs without it).

### One-time setup

1. **Google Cloud console**, the Kivali project's OAuth client (a *Web application*
   client): add `https://kivali.ai/oauth/google/callback` as an authorized redirect URI.
   No JavaScript origins are needed. While the consent screen is in *Testing*, only the
   listed test users can sign in; publish it for everyone else.
2. **The secrets.** Add the client secret as `GOOGLE_CLIENT_SECRET`, and a fresh random
   value (`openssl rand -base64 32`) as `RELAY_SEAL_KEY`, in the `production`
   environment's secrets (never as repository secrets); the Worker declares both names in `workers/oauth-relay/secrets`, so the deploy
   job puts them on the Worker (see "Secrets" above) and fails if either is missing. Until
   they are on the Worker, the callback answers 500 to a code and the token route answers
   500. Rotating `RELAY_SEAL_KEY` only fails sign-ins in flight at that moment.
3. **Deploy** by merging to `main` like any Worker. Then check:

```sh
curl -si 'https://kivali.ai/oauth/google/callback?code=x&state=n.aHR0cHM6Ly9leGFtcGxlLmNvbS9hdXRoL2NhbGxiYWNr'
# 302 with Location: https://example.com/auth/callback?code=k1.…&state=...
curl -si -X POST https://kivali.ai/oauth/google/token -d grant_type=refresh_token
# 400 {"error":"invalid_request","error_description":"grant_type must be authorization_code"}
```

A real sign-in from a Kivali install then shows up as two log lines, and the install
signs the person in. If Google answers `redirect_uri_mismatch` on the consent page, step 1
is missing.

## License

Apache License 2.0. See [LICENSE](LICENSE).
