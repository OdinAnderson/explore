#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Provisions all Azure resources for explore.odinz.net.

.DESCRIPTION
    Run this once to stand up the full infrastructure:
      - Resource group
      - Azure Static Web App (Free tier, linked to GitHub)
      - Container Apps environment (scale-to-zero)
      - Entra ID app registration for MSAL

.PREREQUISITES
    - Azure CLI installed and logged in  (az login)
    - GitHub CLI installed and authenticated  (gh auth login)
    - You own the domain explore.odinz.net (DNS access required for custom domain step)

.EXAMPLE
    ./setup-azure.ps1 -GitHubOrg "yourGitHubUsername" -GitHubRepo "play-odinz-net"
#>

param(
    [Parameter(Mandatory)]
    [string]$GitHubOrg,          # e.g. "johndoe"

    [Parameter(Mandatory)]
    [string]$GitHubRepo,         # e.g. "play-odinz-net"

    [string]$ResourceGroup       = "play-odinz-rg",
    [string]$Location            = "eastus2",
    [string]$SwaName             = "play-odinz-swa",
    [string]$CaeName             = "play-odinz-cae",
    [string]$Domain              = "explore.odinz.net",
    [string]$EntraAppName        = "play-odinz-msal"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "    ✓ $msg"  -ForegroundColor Green }

# ---------------------------------------------------------------------------
# 0. Confirm subscription
# ---------------------------------------------------------------------------
Step "Active Azure subscription"
$sub = az account show --query "{name:name, id:id}" -o json | ConvertFrom-Json
Write-Host "    Subscription : $($sub.name)"
Write-Host "    ID           : $($sub.id)"
$confirm = Read-Host "    Continue with this subscription? [Y/n]"
if ($confirm -and $confirm -notmatch '^[Yy]') { exit 1 }

# ---------------------------------------------------------------------------
# 1. Resource Group
# ---------------------------------------------------------------------------
Step "Resource Group: $ResourceGroup"
az group create --name $ResourceGroup --location $Location --output none
Ok "Resource group ready"

# ---------------------------------------------------------------------------
# 2. Azure Static Web App (Free tier)
# ---------------------------------------------------------------------------
Step "Azure Static Web App: $SwaName"
$swa = az staticwebapp create `
    --name $SwaName `
    --resource-group $ResourceGroup `
    --location $Location `
    --sku Free `
    --branch main `
    --source "https://github.com/$GitHubOrg/$GitHubRepo" `
    --login-with-github `
    --output json | ConvertFrom-Json

Ok "Static Web App created"
Write-Host "    Default hostname : $($swa.defaultHostname)"

# ---------------------------------------------------------------------------
# 3. Store deployment token as GitHub secret
# ---------------------------------------------------------------------------
Step "GitHub Actions secret: AZURE_STATIC_WEB_APPS_API_TOKEN"
$token = az staticwebapp secrets list `
    --name $SwaName `
    --resource-group $ResourceGroup `
    --query "properties.apiKey" -o tsv

gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN `
    --repo "$GitHubOrg/$GitHubRepo" `
    --body $token

Ok "Secret stored in GitHub repo"

# ---------------------------------------------------------------------------
# 4. Custom Domain
# ---------------------------------------------------------------------------
Step "Custom Domain: $Domain"
Write-Host "    Add a CNAME record at your DNS provider:" -ForegroundColor Yellow
Write-Host "      $Domain  →  $($swa.defaultHostname)" -ForegroundColor Yellow
Write-Host "    (Or a TXT validation record if your registrar requires it.)"
Write-Host ""
Write-Host "    Waiting for you to add DNS record before continuing..."
Read-Host "    Press ENTER once the DNS record is saved"

az staticwebapp hostname set `
    --name $SwaName `
    --resource-group $ResourceGroup `
    --hostname $Domain `
    --output none

Ok "Custom domain registered (SSL certificate will provision automatically within minutes)"

# ---------------------------------------------------------------------------
# 5. Container Apps Environment (for future Node.js apps)
# ---------------------------------------------------------------------------
Step "Container Apps Environment: $CaeName"

# Ensure the Container Apps extension is installed
az extension add --name containerapp --upgrade --only-show-errors

az provider register --namespace Microsoft.App --wait | Out-Null
az provider register --namespace Microsoft.OperationalInsights --wait | Out-Null

az containerapp env create `
    --name $CaeName `
    --resource-group $ResourceGroup `
    --location $Location `
    --output none

Ok "Container Apps environment ready (scale-to-zero, consumption plan)"

# ---------------------------------------------------------------------------
# 6. Entra ID App Registration (for MSAL)
# ---------------------------------------------------------------------------
Step "Entra ID App Registration: $EntraAppName"

$redirectUris = @(
    "https://$Domain",
    "https://$($swa.defaultHostname)"
) -join " "

$app = az ad app create `
    --display-name $EntraAppName `
    --sign-in-audience AzureADMyOrg `
    --web-redirect-uris $redirectUris `
    --enable-id-token-issuance true `
    --output json | ConvertFrom-Json

$clientId = $app.appId
$tenantId = (az account show --query tenantId -o tsv)

# Create msal-config.json for use in HTML apps
$msalConfig = @{
    clientId = $clientId
    authority = "https://login.microsoftonline.com/$tenantId"
    redirectUri = "https://$Domain"
} | ConvertTo-Json -Depth 3

$msalConfig | Set-Content -Path "$PSScriptRoot/msal-config.json" -Encoding UTF8

Ok "Entra ID app registered"
Write-Host ""
Write-Host "    Client ID  : $clientId" -ForegroundColor White
Write-Host "    Tenant ID  : $tenantId"  -ForegroundColor White
Write-Host "    msal-config.json written to repo root (git-ignored)"

# ---------------------------------------------------------------------------
# 7. Add msal-config.json to .gitignore
# ---------------------------------------------------------------------------
$gitignorePath = "$PSScriptRoot/.gitignore"
if (-not (Test-Path $gitignorePath)) {
    "msal-config.json`n" | Set-Content $gitignorePath
} elseif (-not (Select-String -Path $gitignorePath -Pattern "msal-config.json" -Quiet)) {
    "`nmsal-config.json" | Add-Content $gitignorePath
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  All resources provisioned successfully!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Site URL  : https://$Domain"
Write-Host "  Azure URL : https://$($swa.defaultHostname)"
Write-Host ""
Write-Host "  Next: push this repo to GitHub — the Actions workflow will deploy automatically."
Write-Host ""
