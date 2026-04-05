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
    - Azure CLI installed  (winget install Microsoft.AzureCLI)
    - GitHub CLI installed and authenticated as OdinAnderson  (gh auth status)
    - You own the domain explore.odinz.net (DNS access required for custom domain step)

    LOGIN TIPS — if you have multiple Azure accounts:
      az login                                          # browser picks account interactively
      az account list --output table                    # see all subscriptions
      az account set --subscription "Visual Studio ..."  # select the right one

.EXAMPLE
    # Simplest — defaults match the explore.odinz.net project:
    ./setup-azure.ps1

    # Override GitHub org if needed:
    ./setup-azure.ps1 -GitHubOrg "OdinAnderson"
#>

param(
    [string]$GitHubOrg           = "OdinAnderson",
    [string]$GitHubRepo          = "explore",
    [string]$GitHubBranch        = "master",          # repo was pushed to master
    [string]$ResourceGroup       = "explore-odinz-rg",
    [string]$Location            = "eastus2",
    [string]$SwaName             = "explore-odinz-swa",
    [string]$CaeName             = "explore-odinz-cae",
    [string]$Domain              = "explore.odinz.net",
    [string]$EntraAppName        = "explore-odinz-msal"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "    ✓ $msg"  -ForegroundColor Green }

# ---------------------------------------------------------------------------
# 0. Ensure logged in and pick the right subscription
# ---------------------------------------------------------------------------
Step "Checking Azure login"
$loginCheck = az account show -o json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "    Not logged in. Opening browser..." -ForegroundColor Yellow
    az login -o none
}

Step "Available subscriptions"
az account list --output table
Write-Host ""
$subChoice = Read-Host "    Enter subscription name or ID to use (ENTER to keep current)"
if ($subChoice) {
    az account set --subscription $subChoice
    if ($LASTEXITCODE -ne 0) { Write-Host "    Failed to set subscription." -ForegroundColor Red; exit 1 }
}

$sub = az account show --query "{name:name, id:id, tenantId:tenantId}" -o json | ConvertFrom-Json
Write-Host ""
Write-Host "    Subscription : $($sub.name)" -ForegroundColor White
Write-Host "    ID           : $($sub.id)"   -ForegroundColor White
Write-Host "    Tenant       : $($sub.tenantId)" -ForegroundColor White
$confirm = Read-Host "    Proceed with this subscription? [Y/n]"
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
    --branch $GitHubBranch `
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
