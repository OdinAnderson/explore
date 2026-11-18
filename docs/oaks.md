# Hosting explore on oaks

Explore is live on Azure Static Web Apps at **explore.odinz.net**, deployed from
`main` by GitHub Actions. A second copy is being prepared on Odin's server
**oaks**, served by Caddy at the temporary name **explore-new.odinz.net**. That
copy adds private tiles behind the sign-in hub at **auth.odinz.net**. Sign in
once at the hub; Explore checks the hub silently.

Both sites are built from the same repo by `scripts/build.mjs`; only the build
target differs.

## Build targets

| | `azure` (default) | `oaks` |
|---|---|---|
| Command | `node scripts/build.mjs` | `node scripts/build.mjs --target oaks` (or `EXPLORE_TARGET=oaks`) |
| Used by | the Azure SWA workflow | `deploy/deploy.sh` |
| Public cards in `index.html` | yes | yes, identical |
| Header pawn and sign-in loader in `index.html` | no | yes |
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
  authenticated. It carries no real data. Authenticated coming-soon cards
  carry `class="private-placeholder"` and `data-app-id`. The oaks loader hides
  those cards only after at least one private tile has been shown. Signed out
  (including after a silent hub check that finds no session), a failed
  `/_sso/me`, or a missing, forbidden, or empty tile list leaves the
  placeholder on the page.
- **Public tile**: `visibility: "public"`. Renders in the public page.

Today **Flock Dashboard** (`https://dash.flock.odinz.net`, repo
`OdinAnderson/edge-dashboard`) is the private tile. Its icon is the 📊 emoji
with `favicon: "never"`, so the card does not send that hostname to a favicon
service. **Private Tool** remains the public coming-soon placeholder. The
Azure build has neither the Flock Dashboard name nor its URL.

`private/tiles.json` holds the card fields as raw JSON
(`id, name, description, url, repo, icon, tags, status`). `private/index.html`
is a tiny page that redirects to `/`, so a direct visit to `/private/` lands
back on the catalog. Sign-in is the header pawn, not this page.

### What the page does on oaks

The oaks `index.html` loads the shared pawn from the hub
(`https://auth.odinz.net/static/pawn.css` and `pawn.js`, the script `defer`)
and carries a small inline script (`#explore-sso-loader`). The pawn is a slim
control in a header just above the ASCII hero. The figlet wordmark stays.
The pawn is always there, including when this build has no private tiles.
The Azure build has neither the pawn nor the loader.

`pawn.js` only opens and closes the `<details data-pawn>` the loader rendered
(Escape, click or pointer outside, `aria-expanded`). It does not write markup.
The loader uses the same class names as the hub: `id-anchor`, `pawn-btn`,
`pawn-chip`, `pawn-icon`, `pawn-face-filled`, `pawn-label`, `id-card`,
`account-name`, `account-email`, `account-provider`, `account-signout`,
`signout-btn`.

1. The loader paints the signed-out pawn immediately: a person-outline
   silhouette (head and shoulders) in the chip. Signed in, the chip shows
   initials and the name. Opening the signed-out pawn offers **Sign in with
   Microsoft** and **Sign in with Google**
   (Microsoft first). Each link goes to the hub and comes back to the current
   page, for example
   `https://auth.odinz.net/oauth/login/microsoft?rd=<current URL>`
   and the Google equivalent.
2. It then `GET /_sso/me` (same-origin credentials, `Accept: application/json`).
   Identity fields are `signed_in`, `email`, `name`, `provider`, and `csrf`.
3. If `signed_in` is true: the chip shows initials and the name. The menu
   shows the name, email, and provider. **Sign out** is a POST form to
   `/_sso/logout` carrying the `csrf` value. The button label is "Sign out".
   That POST ends the central session. The menu does not list sites.
   Initials are two letters from the name, or from the email's local part
   when the name is empty, upper case.
4. If the visitor is signed in and the build has private tiles, it fetches
   `/private/tiles.json` and renders them in a "🔒 Private" section above the
   footer. After at least one private tile is shown, it hides every
   `.private-placeholder` card (the Private Tool coming-soon placeholder).
   Public live cards stay visible.
5. A 403 on the tile list, a missing file, or an empty list leaves the
   signed-in pawn, omits the Private section, and leaves the placeholder
   visible.
6. If `signed_in` is false, Explore checks the hub silently. Sign in once at
   the hub and this page picks that session up.
   - `sso=none` on the URL means the hub has no session. The loader stores
     `sessionStorage` key `edgeauth-sso-checked` (the time of the check),
     removes `sso=none` with `history.replaceState` (other query parameters
     and the hash stay), and stays signed out.
   - If `edgeauth-sso-checked` is already set and less than 10 minutes old,
     the loader stays signed out.
   - Otherwise it stores that key first, then replaces the page with
     `https://auth.odinz.net/login?silent=1&rd=<current URL>`. The return URL
     does not include `sso=none`. A hub session comes back through
     `/_sso/callback`, which sets the site cookie. No hub session comes back
     here with `sso=none`.
   - If `sessionStorage` is unavailable, the loader stays on the page. The
     stamp is written before the hop, so a hub that cannot bounce back cannot
     reload this page forever.
7. If `/_sso/me` is missing, fails, or returns non-JSON: the page stays on
   the signed-out pawn and the public tiles, including the placeholder. It
   does not hop. The footer has no "Sign in" link.

The cards are built with `createElement`, `textContent` and `setAttribute`,
never `innerHTML`. Links must be `http(s)://` or a site path (`/…`); anything
else is dropped by the loader and rejected by the build's validation. The
private cards keep their emoji icon: the favicon swap would send their
hostnames to Google's favicon service.

Every failure is caught; the page stays as the public page plus the signed-out
pawn.

### Security model

- The private data exists in exactly one file, `private/tiles.json`, on oaks
  only. Caddy serves `/private/*` only after `forward_auth` to the hub allows
  the request. The page script is a convenience, not the gate.
- The Azure build never contains private data: no `private/` dir, no names or
  URLs of private tiles in any file, no loader, no pawn, and no
  `auth.odinz.net` URL. Tests check this with a fixture that has a live
  private tile.
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
  `csrf` form field → ends the central session, 303 to `/`; `GET /_sso/callback`
  is part of the login handoff. The pawn's button says "Sign out". No new
  Caddy route is required for the pawn: the stylesheet and script load from
  `https://auth.odinz.net/static/`, and the sign-in links go to the hub's
  `/oauth/login/microsoft` and `/oauth/login/google`. No new Caddy route is
  required for the silent check: the browser goes to
  `https://auth.odinz.net/login?silent=1&rd=<this page>`, and the hub either
  returns through `/_sso/callback` or straight back with `sso=none`;
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
