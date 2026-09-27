<#
.SYNOPSIS
    smol-pro.ps1 — Lanceur Intelligent & Optimisé pour Smolcoder (Machine DELL 32 Go RAM)
.DESCRIPTION
    1. Analyse la RAM système en temps réel
    2. Calcule la fenêtre de contexte maximale sans saturer la machine
    3. Précharge le modèle dans Ollama pour éliminer tout temps de latence au démarrage
    4. Lance Smolcoder avec les options optimales
#>

param (
    [string]$Model = "",
    [int]$Ctx = 0,
    [string]$Mode = "edit",
    [string]$Verify = "",
    [switch]$Web,
    [switch]$Build,
    [string]$RepoRoot = ""
)

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "     SMOLCODER PRO — LANCEUR HAUTE PERFORMANCE       " -ForegroundColor Yellow
Write-Host "======================================================" -ForegroundColor Cyan

# 0. Résolution du dépôt canonique et du runtime local.
# Le script est conservé sous extras/secondary-agent-tools ; deux niveaux
# au-dessus se trouve la racine de smolcoder-source.
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
$RepoRoot = (Resolve-Path $RepoRoot).Path
$distJs = Join-Path $RepoRoot "dist\index.js"
$packageJson = Join-Path $RepoRoot "package.json"
if (-not (Test-Path $packageJson)) {
    throw "Dépôt Smolcoder introuvable : $RepoRoot"
}
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node.exe est introuvable dans PATH." }
if (-not $npmCmd) { throw "npm.cmd est introuvable dans PATH." }

# 1. Analyse de la RAM disponible
$os = Get-CimInstance Win32_OperatingSystem
$freeRamGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
$totalRamGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)

Write-Host "[RAM] Totale : $totalRamGB Go | Libre : $freeRamGB Go" -ForegroundColor Green

# 2. Calcul dynamique de la fenêtre de contexte si non spécifiée
if ($Ctx -eq 0) {
    if ($Model -match "35b") {
        $Ctx = 8192
        Write-Host "[Sécurité RAM] Modèle 35B détecté (~21 Go) -> Contexte fixé à 8 192 tokens." -ForegroundColor Yellow
    } elseif ($Model -match "27b" -or $Model -match "20b") {
        $Ctx = 16384
        Write-Host "[Sécurité RAM] Modèle 27B/20B détecté (~18 Go) -> Contexte fixé à 16 384 tokens." -ForegroundColor Yellow
    } else {
        $Ctx = 32768
        Write-Host "[Optimisation] Modèle léger/moyen -> Contexte maximal fixé à 32 768 tokens." -ForegroundColor Green
    }
}

# 3. Compilation automatique du dépôt unifié.
# Le build est déclenché explicitement avec -Build ou si dist/index.js manque.
$needsBuild = $Build -or -not (Test-Path $distJs)
if (-not $needsBuild) {
    $distTime = (Get-Item $distJs).LastWriteTimeUtc
    $sourceTime = Get-ChildItem (Join-Path $RepoRoot "src"), $packageJson, (Join-Path $RepoRoot "tsconfig.json") -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    $needsBuild = $sourceTime -and $sourceTime.LastWriteTimeUtc -gt $distTime
}
if ($needsBuild) {
    Write-Host "[Build] Compilation du dépôt Smolcoder..." -ForegroundColor Cyan
    Push-Location $RepoRoot
    try {
        & $npmCmd.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build a échoué (code $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

# 4. Préchargement (Warm-up) optionnel du modèle si Ollama local
if ($Model -and $Model -notmatch "claude|gpt|gemini") {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/generate" -Method Post -Body (@{
            model = $Model
            prompt = ""
            keep_alive = "30m"
        } | ConvertTo-Json) -TimeoutSec 3 -ErrorAction SilentlyContinue
    } catch {}
}

# 4. Construction des arguments Smolcoder
$smolArgs = @()
if ($Model) {
    $smolArgs += @("--model", $Model)
}
if ($Ctx -gt 0) {
    $smolArgs += @("--ctx", $Ctx)
}
if ($Mode) {
    $smolArgs += @("-m", $Mode)
}
if ($Verify) {
    $smolArgs += @("--verify", $Verify, "--verify-attempts", "6")
}
if ($Web) {
    $smolArgs += @("--web")
}

Write-Host "`nLancement de Smolcoder : smol $($smolArgs -join ' ')..." -ForegroundColor White
Write-Host "======================================================`n" -ForegroundColor Cyan

Write-Host "[Dépôt] $RepoRoot" -ForegroundColor DarkGray
& $nodeCmd.Source $distJs @smolArgs
exit $LASTEXITCODE
