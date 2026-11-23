# explore.odinz.net

AI experiments hosted at [explore.odinz.net](https://explore.odinz.net).  
*Build · Break · Repeat*

Live on Odin's server **oaks** at https://explore.odinz.net, served by Caddy, with private tiles gated by the sign-in hub at https://auth.odinz.net. Sign in once at the hub; Explore checks that session silently. https://explore-new.odinz.net is an alias of the same site. See [docs/oaks.md](docs/oaks.md).

The GitHub Action on `main` and on pull requests is CI only (`npm test`, which builds both targets). It does not deploy. Deploying to oaks is `bash deploy/deploy.sh <tag>` (see [docs/oaks.md](docs/oaks.md#deploy)).

---

## Live URLs

| | URL |
|---|---|
| **Site** (oaks) | https://explore.odinz.net |
| **Alias** (same site) | https://explore-new.odinz.net |
| **GitHub repo** | https://github.com/OdinAnderson/explore |

---

## Catalog and build

Explore is a signpost catalog: each card links out to an app hosted elsewhere. The cards come from `apps.json` (schema: `apps.schema.json`). `node scripts/build.mjs` validates it, renders the cards into `index.html`, names the service worker's cache from a hash of the sources, and writes the site to `dist/`.

```bash
npm run build          # catalog-only target (`azure`, the default) -> dist/; public data only, for local checks and CI
npm run build:oaks     # oaks target, what deploy/deploy.sh builds: adds the sign-in loader and private/tiles.json
npm test               # builds into temp dirs and checks both targets, sw.js and deploy/deploy.sh
npm run check-links    # checks every live URL in apps.json
```

Deploying to oaks: `bash deploy/deploy.sh <tag>` (see [docs/oaks.md](docs/oaks.md)).

---

## Adding an app

1. Host the app wherever it lives (GitHub Pages, its own server, a container, …).
2. Add an entry to `apps.json`: `id`, `name`, a one-sentence `description`, `url` (`https://…`), `repo` (`owner/repo` or `null`), `icon` (`emoji`, and `favicon: "auto"` to try the site's favicon or `"never"` to keep the emoji; optional `src`, a same-origin `/icons/…` path to a file vendored in `icons/`, shows that image instead of the emoji), `tags`, `status` (`live`, `coming-soon` or `archived`), `visibility` (`public` or `authenticated`), `added`, `updated`.
3. `npm run build` and open `dist/index.html` to check, then commit and open a PR to `main`. CI runs `npm test` on the PR.
4. Going live: after the merge, tag the release (`vYYYY.MM.DD-N`) and run `bash deploy/deploy.sh <tag>` (see [docs/oaks.md](docs/oaks.md#deploy)). Merging alone does not deploy.

The order of entries in `apps.json` is the order of the cards.

`.github/workflows/_container-template.yml` is an unused copy-me template, not part of how Explore is hosted. It builds an image from `containers/<app>/`, pushes it to ghcr.io and deploys it to Azure Container Apps; to use it for a server-side app, copy it, set `APP_NAME` and `PORT`, and list the app's URL in `apps.json`.

---

### Making an experiment private

**Private tiles (oaks).** Set `"visibility": "authenticated"` on a `live` or `archived` entry in `apps.json`. The tile then never appears in the public `index.html`. The oaks build puts it in `private/tiles.json`, which Caddy serves only behind `forward_auth` to the sign-in hub; signed-in, allowed visitors see it in the page's one "🔒 Private" section, the same section that holds the coming-soon placeholder for everyone else. Sign in once at the hub; Explore checks the hub silently, so a session already on the hub shows up here. The catalog-only build (`npm run build`, target `azure`) must contain no trace of it; tests check this. `coming-soon` entries render publicly as placeholders whatever their visibility. The private tiles are **Flock Dashboard** (`https://dash.flock.odinz.net`) and **Parley** (`https://github.com/BeachMonkey-AI/parley`); the catalog-only/default build contains neither private name nor either private URL. **WODin** is a public tile linking to its GitHub repo (`https://github.com/BeachMonkey-AI/WODin`); its card shows a vendored copy of the WODin repo's favicon (`public/icon.svg`, served same-origin as `/icons/wodin.svg`), not the weightlifter emoji and not a hotlinked or auto-fetched favicon. **Private Tool** remains the public coming-soon placeholder; the oaks loader hides that placeholder only after private tiles have rendered for a signed-in visitor. Details and the security model: [docs/oaks.md](docs/oaks.md#private-tiles).

This hides the tile from the site, not the app it links to (the app must protect itself) and not the `apps.json` entry from anyone who can read this repository.

---

## PWA

The landing page is a Progressive Web App — installable on iPhone and Android:
- **iOS**: Safari → Share → Add to Home Screen
- **Android**: Chrome → ⋮ → Add to Home Screen

Icons: `icons/icon-192.png` and `icons/icon-512.png` (the pixel 'e' from the hero header).

The build names the service worker's cache from a hash of `apps.json`, `index.html`, `sw.js` and `manifest.json`, so changes to those reach existing installs without a hand-edited version. The icons are not in the hash: if you replace an icon, change one of those files too (or rename the icon). `/private/*`, `/_sso/*`, `/healthz` and `/VERSION` are never cached.

---

## Mobile

The landing page targets modern iPhones (375px+) with Chrome/Edge/Safari.  
Linked apps are responsible for their own mobile layout.  
Recommended viewport tag for any app:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```
