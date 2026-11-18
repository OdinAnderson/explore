# explore.odinz.net

AI experiments hosted at [explore.odinz.net](https://explore.odinz.net).  
*Build · Break · Repeat*

Live on **Azure Static Web Apps** (Free tier) at explore.odinz.net — global CDN, free SSL, auto-deploy from `main` via GitHub Actions.

A self-hosted copy is being prepared on Odin's server **oaks**, behind Caddy at **explore-new.odinz.net**, with private tiles behind the sign-in hub at auth.odinz.net. Sign in once at the hub; Explore checks that session silently. See [docs/oaks.md](docs/oaks.md). explore.odinz.net stays on Azure until its DNS moves.

---

## Live URLs

| | URL |
|---|---|
| **Custom domain** (Azure) | https://explore.odinz.net |
| **Azure default** | https://ambitious-ocean-002e3fd0f.2.azurestaticapps.net |
| **oaks** (being prepared) | https://explore-new.odinz.net |
| **GitHub repo** | https://github.com/OdinAnderson/explore |

---

## Catalog and build

Explore is a signpost catalog: each card links out to an app hosted elsewhere. The cards come from `apps.json` (schema: `apps.schema.json`). `node scripts/build.mjs` validates it, renders the cards into `index.html`, names the service worker's cache from a hash of the sources, and writes the site to `dist/`. The Azure workflow runs exactly that and deploys `dist/`.

```bash
npm run build          # Azure target (default) -> dist/
npm run build:oaks     # oaks target: adds the sign-in loader and private/tiles.json
npm test               # builds into temp dirs and checks both targets, sw.js and deploy/deploy.sh
npm run check-links    # checks every live URL in apps.json
```

Deploying to oaks: `bash deploy/deploy.sh <tag>` (see [docs/oaks.md](docs/oaks.md)).

---

## Adding an app

1. Host the app wherever it lives (its own Static Web App, GitHub Pages, a container, …).
2. Add an entry to `apps.json`: `id`, `name`, a one-sentence `description`, `url` (`https://…`), `repo` (`owner/repo` or `null`), `icon` (`emoji`, and `favicon: "auto"` to try the site's favicon or `"never"` to keep the emoji), `tags`, `status` (`live`, `coming-soon` or `archived`), `visibility` (`public` or `authenticated`), `added`, `updated`.
3. `npm run build` and open `dist/index.html` to check, then commit and push (via a PR to `main`). The Azure workflow builds and deploys.

The order of entries in `apps.json` is the order of the cards.

For a server-side app on Azure, `.github/workflows/_container-template.yml` is a template that builds an image from `containers/<app>/`, pushes it to ghcr.io and deploys it to Azure Container Apps (scale to zero). Copy it, set `APP_NAME` and `PORT`, and list the Container App's URL in `apps.json`.

---

### Making an experiment private

**Private tiles (oaks).** Set `"visibility": "authenticated"` on a `live` or `archived` entry in `apps.json`. The tile then never appears in the public `index.html` on either site. The oaks build puts it in `private/tiles.json`, which Caddy serves only behind `forward_auth` to the sign-in hub; signed-in, allowed visitors see it in the page's one "🔒 Private" section, the same section that holds the coming-soon placeholder for everyone else. Sign in once at the hub; Explore checks the hub silently, so a session already on the hub shows up here. The Azure build contains no trace of it. `coming-soon` entries render publicly as placeholders whatever their visibility. The private tiles are **Flock Dashboard** (`https://dash.flock.odinz.net`) and **Parley** (`https://github.com/BeachMonkey-AI/parley`); the Azure/default build contains neither private name nor either private URL. **WODin** is a public tile linking to its GitHub repo (`https://github.com/BeachMonkey-AI/WODin`). **Private Tool** remains the public coming-soon placeholder; the oaks loader hides that placeholder only after private tiles have rendered for a signed-in visitor. Details and the security model: [docs/oaks.md](docs/oaks.md#private-tiles).

This hides the tile from the sites, not the app it links to (the app must protect itself) and not the `apps.json` entry from anyone who can read this repository.

**Private paths on the Azure site (Entra ID login required).** Static Web Apps can require sign-in for a path with a route in `staticwebapp.config.json`:

```json
{
  "routes": [
    { "route": "/apps/my-experiment/*", "allowedRoles": ["authenticated"] }
  ]
}
```

SWA handles the Entra ID login flow (the config's 401 override redirects to `/.auth/login/aad`). The config already has such a route for `/apps/protected/*`. The build deploys only the catalog today, so nothing is served under `/apps/` yet; a route only matters once pages are added to `dist/`. This applies to the Azure site only; on oaks, Caddy and the sign-in hub do the gating.

---

## Azure Resources

| Resource | Name | Notes |
|---|---|---|
| Resource Group | `Explore` | East US 2 |
| Static Web App | `explore-odinz-swa` | Free tier, linked to this repo (`main` branch) |
| GitHub Secret | `AZURE_STATIC_WEB_APPS_API_TOKEN_AMBITIOUS_OCEAN_002E3FD0F` | Auto-deploy token |

### Re-provisioning from scratch

```powershell
# Requires: az login, gh auth login (as OdinAnderson)
# from the root of this repo
./setup-azure.ps1
# All defaults are pre-configured — just follow the prompts
```

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
