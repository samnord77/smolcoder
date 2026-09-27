#Requires -Version 5.1
<#
  Installateur Smolcoder en un clic (Windows, sans droits admin).
  Clic droit > "Exécuter avec PowerShell", ou double-clic si les scripts sont autorisés.
  Fait : vérifie Node 18+, installe les dépendances, compile, installe la
  commande `smol`, crée le raccourci "Smolcoder" (bureau + menu Démarrer).
#>
$ErrorActionPreference = "Stop"

function Step($label, [scriptblock]$action) {
  Write-Host ""
  Write-Host "==> $label" -ForegroundColor Cyan
  try {
    & $action
    Write-Host "    OK" -ForegroundColor Green
    return $true
  } catch {
    Write-Host ("    ÉCHEC : " + $_.Exception.Message) -ForegroundColor Red
    return $false
  }
}

function Find-Node() {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)})
  foreach ($root in $roots) {
    $candidate = Join-Path $root "nodejs\node.exe"
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Smolcoder — installation dans $root" -ForegroundColor Yellow

$nodeExe = Find-Node
if (-not $nodeExe) {
  Write-Host "Node.js 18+ est introuvable." -ForegroundColor Red
  Write-Host "1. Installez-le depuis https://nodejs.org (LTS),"
  Write-Host "2. Relancez ce script."
  Start-Process "https://nodejs.org"
  Read-Host "Appuyez sur Entrée pour fermer"
  exit 1
}
$nodeVersion = (& $nodeExe --version).Trim()
$major = [int](($nodeVersion.TrimStart("v") -split "\.")[0])
if ($major -lt 18) {
  Write-Host "Node.js $nodeVersion trop ancien (18+ requis). Mettez à jour depuis https://nodejs.org." -ForegroundColor Red
  Read-Host "Appuyez sur Entrée pour fermer"
  exit 1
}
Write-Host "Node.js $nodeVersion détecté : $nodeExe" -ForegroundColor Green

$npmCmd = Join-Path (Split-Path -Parent $nodeExe) "npm.cmd"
if (-not (Test-Path $npmCmd)) { $npmCmd = "npm" }

$ok = $true
$ok = (Step "Installation des dépendances (npm install)" { & $npmCmd install --no-audit --no-fund }) -and $ok
if ($ok) {
  $ok = (Step "Compilation (npm run build)" { & $npmCmd run build }) -and $ok
}
if ($ok) {
  $ok = (Step "Commande globale `smol` (npm install -g)" { & $npmCmd install -g --no-audit --no-fund $root }) -and $ok
}

if ($ok) {
  Step "Raccourcis bureau + menu Démarrer" {
    $desktopDir = Join-Path $root "desktop"
    $launcher = Join-Path $root "Smolcoder.bat"
    if (-not (Test-Path $launcher)) {
      "@echo off`r`ncd /d `"$desktopDir`"`r`ncall npx electron .`r`n" | Set-Content -Path $launcher -Encoding Ascii
    }
    $shell = New-Object -ComObject WScript.Shell
    $targets = @(
      (Join-Path ([Environment]::GetFolderPath("Desktop")) "Smolcoder.lnk"),
      (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Smolcoder.lnk")
    )
    foreach ($link in $targets) {
      $sc = $shell.CreateShortcut($link)
      $sc.TargetPath = $launcher
      $sc.WorkingDirectory = $desktopDir
      $sc.Description = "Smolcoder — agent de codage local"
      $sc.Save()
    }
  } | Out-Null
}

Write-Host ""
if ($ok) {
  Write-Host "Terminé ! Lancez Smolcoder depuis le bureau ou le menu Démarrer," -ForegroundColor Green
  Write-Host "ou tapez  smol  dans un terminal (interface texte),  smol --web  pour le navigateur."
} else {
  Write-Host "L'installation a échoué à une étape (voir ci-dessus). Corrigez puis relancez." -ForegroundColor Red
}
Read-Host "Appuyez sur Entrée pour fermer"
