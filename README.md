# explore.odinz.net

AI experiments hosted at [explore.odinz.net](https://explore.odinz.net).  
*Build · Break · Repeat*

Hosted on **Azure Static Web Apps** (Free tier) — global CDN, free SSL, auto-deploy from `main` via GitHub Actions.

---

## Promoting an experiment

You built something locally. Here's how to get it live — pick the pattern that fits:

| | **Pattern A** | **Pattern B** | **Pattern C** |
|---|---|---|---|
| **Best for** | Single HTML file, no build step | React / Vue / framework with a build step | Node.js or anything needing a server |
| **Step 1** | Create `apps/my-app/index.html` (+ any assets) | Run `npm run build` locally | Create `containers/my-app/` with a `Dockerfile` |
| **Step 2** | Add a card to `index.html` | Copy `dist/` output into `apps/my-app/` | Copy & edit `.github/workflows/_container-template.yml` |
| **Step 3** | `git add`, `commit`, `push` | Add a card to `index.html` | Add a card pointing to the Container App URL |
| **Step 4** | ✅ Live at `/apps/my-app/` | `git add`, `commit`, `push` | `git add`, `commit`, `push` |
| **Step 5** | | ✅ Live at `/apps/my-app/` | ✅ Live at Container App URL (or custom subdomain) |
| **Azure services** | SWA only | SWA only | SWA + Container Apps (scale-to-zero) |
| **Make private** | One route in `staticwebapp.config.json` | One route in `staticwebapp.config.json` | EasyAuth on the Container App |

> **Pattern A tip:** Copy an existing card block from `index.html` and edit the `href`, icon, title, and description.  
> **Pattern B tip:** Point `output_location` in the SWA workflow to your build folder and let SWA build automatically on push instead of copying manually.  
> **Pattern C tip:** Container Apps scale to zero when idle — no traffic means $0 cost.

---

### Pattern A — Single HTML file

```
apps/
  my-experiment/
    index.html        ← your work
    style.css, script.js, assets/ ...

git add apps/my-experiment/ index.html
git commit -m "Add: my experiment"
git push
# → https://explore.odinz.net/apps/my-experiment/
```

Card template to paste into `index.html`:

```html
<a class="card" href="/apps/my-experiment/">
  <div class="card-icon">🔬</div>
  <div class="card-title">My Experiment</div>
  <div class="card-desc">One-line description.</div>
  <div class="card-footer">
    <span class="tag tag-public">Public</span>
    <span class="card-arrow">→</span>
  </div>
</a>
```

---

### Pattern B — Framework app (built output)

```
npm run build                        # produces dist/ or build/

# copy output into apps/
apps/
  my-app/
    index.html
    assets/

git add apps/my-app/ index.html
git commit -m "Add: my app"
git push
```

---

### Pattern C — Node.js / server-side app

```
containers/
  my-node-app/
    Dockerfile
    package.json
    src/

cp .github/workflows/_container-template.yml \
   .github/workflows/my-node-app.yml
# edit APP_NAME, PORT in the copied file

git add containers/my-node-app/ .github/workflows/my-node-app.yml index.html
git commit -m "Add: my node app"
git push
# → builds image → pushes to ghcr.io → deploys to Azure Container Apps
```

---

### Making an experiment private (Entra ID login required)

Add one line to `staticwebapp.config.json`:

```json
{
  "routes": [
    { "route": "/apps/my-experiment/*", "allowedRoles": ["authenticated"] }
  ]
}
```

That's it. SWA handles the Entra ID login flow — no code changes to your experiment needed.

---

## Azure Resources

| Resource | Name |
|---|---|
| Resource Group | `explore-odinz-rg` |
| Static Web App | `explore-odinz-swa` |
| Container Apps Env | `explore-odinz-cae` |

Run `./setup-azure.ps1 -GitHubOrg <you> -GitHubRepo <repo>` to provision everything.

---

## Mobile

The landing page targets modern iPhones (375px+) with Chrome/Edge.  
Experiments under `apps/` are responsible for their own mobile layout.  
Recommended viewport tag for any experiment:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```
