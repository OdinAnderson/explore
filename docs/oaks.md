# Hosting explore on oaks

Explore is live on Azure Static Web Apps at **explore.odinz.net**, deployed from
`main` by GitHub Actions. A second copy is being prepared on Odin's server
**oaks**, served by Caddy at the temporary name **explore-new.odinz.net**. That
copy adds private tiles behind the sign-in hub at **auth.odinz.net**.

Both sites are built from the same repo by `scripts/build.mjs`; only the build
target differs.

## Build targets

| | `azure` (default) | `oaks` |
|---|---|---|
| Command | `node scripts/build.mjs` | `node scripts/build.mjs --target oaks` (or `EXPLORE_TARGET=oaks`) |
| Used by | the Azure SWA workflow | `deploy/deploy.sh` |
| Public cards in `index.html` | yes | yes, identical |
| Sign-in loader in `index.html` | no | yes |
| `private/tiles.json`, `private/index.html` | never written | written |
| `VERSION` | never written | written when a version tag is given |
| `staticwebapp.config.json` | copied | not shipped (Caddy does the routing) |

Options (flags win over environment variables):

| Flag | Environment | Default |
|---|---|---|
| `--target azure\|oaks` | `EXPLORE_TARGET` | `azure` |
| `--out <dir>` | `EXPLORE_OUT` | `dist/` |
| `--apps <file>` | `EXPLORE_APPS` | `apps.json` |
| `--version-tag <tag>` | `EXPLORE_VERSION_TAG` | none (no `VERSION`) |
| `--version-commit <sha>` | `EXPLORE_VERSION_COMMIT` | `unknown` |
| | `EXPLORE_VERSION_BUILT_AT` | the current UTC time |

`VERSION` is three lines: `tag=…`, `commit=…`, `built_at=…`.

Every build removes `private/` and `VERSION` from the output dir before
writing, so a default build into a dir that once held an oaks build leaves no
private data behind.

`npm test` builds into temp dirs and checks all of the above.

## Private tiles

In `apps.json`, `"visibility": "authenticated"` marks a tile as needing sign-in.

- **Private tile**: `visibility: "authenticated"` and `status: "live"` or
  `"archived"`. Never written into `index.html` by either target. The oaks
  build writes it to `private/tiles.json` only.
- **Placeholder**: `status: "coming-soon"`, whatever the visibility. Renders in
  the public page exactly as before, in the "Sign-in Required" section when
  authenticated. It carries no real data.
- **Public tile**: `visibility: "public"`. Renders in the public page.

`private/tiles.json` holds the card fields as raw JSON
(`id, name, description, url, repo, icon, tags, status`). `private/index.html`
is a tiny page that redirects to `/`: it is where the "Sign in" link points, so
the sign-in round trip lands back on the catalog.

### What the page does on oaks

The oaks `index.html` carries a small inline script (`#explore-sso-loader`):

1. `GET /_sso/me` (same-origin credentials, `Accept: application/json`).
2. If `signed_in` is true: shows "Signed in as <email> – Sign out" in the
   footer. Sign out is a POST form to `/_sso/logout` carrying the `csrf` value
   from `/_sso/me`. If the build has private tiles, it then fetches
   `/private/tiles.json` with `Accept: application/json` and renders them in a
   "🔒 Private" section above the footer.
3. Otherwise, or if `/_sso/me` is missing, fails or returns non-JSON: shows a
   small "Sign in" link to `/private/`, and only if the build has at least one
   private tile.

The cards are built with `createElement`, `textContent` and `setAttribute`,
never `innerHTML`. Links must be `http(s)://` or a site path (`/…`); anything
else is dropped by the loader and rejected by the build's validation. The
private cards keep their emoji icon: the favicon swap would send their
hostnames to Google's favicon service.

Every failure is caught; the page stays as the public page.

### Security model

- The private data exists in exactly one file, `private/tiles.json`, on oaks
  only. Caddy serves `/private/*` only after `forward_auth` to the hub allows
  the request. The page script is a convenience, not the gate.
- The Azure build never contains private data: no `private/` dir, no names or
  URLs of private tiles in any file, no loader. Tests check this with a fixture
  that has a live private tile.
- The service worker never caches `/private/*`, `/_sso/*`, `/healthz` or
  `/VERSION` (network-only), and on activate deletes any cached `/private/` or
  `/_sso/` entries an older worker may have stored.
- The tile list is the only thing protected. The apps a tile links to are
  separate sites and must protect themselves.
- Private tiles are hidden from the *sites*, not from the *repository*: their
  entries are in `apps.json`, so anyone who can read this repo (and its Actions
  logs, e.g. `check-links`) can see them. Keep the repo private, or keep
  anything truly secret out of `apps.json`.

## Caddy expectations

The site block for `explore-new.odinz.net` lives under `/etc/caddy` (the deploy
script checks for it). It must:

- answer `/healthz` with `ok` itself;
- proxy `/_sso/*` to the hub. Endpoints used here: `GET /_sso/me` → JSON
  `{signed_in, email, name, provider, csrf}`; `POST /_sso/logout` with a
  `csrf` form field → signs out everywhere, 303 to `/`; `GET /_sso/callback`
  is part of the login handoff;
- protect `/private/*` with `forward_auth` to the hub: a signed-out navigation
  gets a 302 to `https://auth.odinz.net/login?rd=<this URL>`, a signed-out
  fetch (`Accept: application/json`) gets 401, signed in but not allowed gets
  403;
- serve `/opt/explore/current` with `file_server`, publicly.

## Layout on oaks

```
/opt/explore/
  current -> /opt/explore/releases/<tag>    symlink, switched atomically
  releases/<tag>/                           one dir per release, root:root 755/644
    index.html  sw.js  manifest.json  icons/  private/  VERSION
  manifests/<tag>.SHA256SUMS                checksums, outside the served tree
```

## Deploy

From a clone with the tag (Git Bash on Windows, or Linux):

```bash
git tag v2026.11.18-1 && git push origin v2026.11.18-1
bash deploy/deploy.sh v2026.11.18-1
```

`deploy/deploy.sh <tag>`:

1. Validates the tag's characters and fetches tags if it is missing locally.
2. Exports the tag with `git archive` into a temp dir (the worktree is never
   touched) and runs `node scripts/build.mjs` there with `EXPLORE_TARGET=oaks`
   and the tag and commit for `VERSION`.
3. Writes a files list (VERSION last) and `SHA256SUMS`, and copies the payload
   to `$EXPLORE_DEPLOY_HOST` (default `oaks`) with `scp`.
4. On oaks (`sudo -n`; aborts if sudo needs a password):
   - fails with a clear message if no Caddy site block for the hostname exists
     under `/etc/caddy`;
   - if `releases/<tag>/` already exists and matches its manifest exactly, reuses
     it; otherwise installs into a staging dir (root:root 755/644), verifies
     every file's SHA256, writes `VERSION` last, verifies again and moves it
     into place;
   - points `current` at the release with `ln -sfn` into a temp link and
     `mv -T` (atomic);
   - checks `curl -s --resolve "explore-new.odinz.net:443:127.0.0.1"
     https://explore-new.odinz.net/VERSION` reports the tag. A mismatch is a
     failure, and `current` is switched back to the previous release;
   - keeps the newest 5 releases plus `current`, and removes the rest.

No service is restarted: the site is static. Running it again with the same tag
is safe. `EXPLORE_HOSTNAME` overrides the hostname that is checked (default
`explore-new.odinz.net`).

### Rollback

Run the script with an older tag:

```bash
bash deploy/deploy.sh v2026.11.10-1
```

If that release is still in `releases/` and verifies against its manifest, it is
reused as is; otherwise it is rebuilt from the tag and installed. Either way
`current` switches atomically and `VERSION` is checked.

## Cutover

`explore.odinz.net` stays on Azure until its DNS moves to oaks. When it does,
add `explore.odinz.net` to the Caddy site block and deploy with
`EXPLORE_HOSTNAME=explore.odinz.net`. The Azure Static Web App is kept after the
cutover, still deploying from `main`, and stays reachable at its
`*.azurestaticapps.net` address.
