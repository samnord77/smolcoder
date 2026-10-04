@echo off
chcp 65001 >nul
title Smolcoder IDE Pro — Demarrage
echo ========================================================
echo              SMOLCODER IDE PRO (ELECTRON)
echo ========================================================
echo.

:: 1. Verification d'Ollama
curl.exe -s http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo [1/3] Demarrage du serveur Ollama...
    start /min "" "C:\Users\DELL\AppData\Local\Programs\Ollama\ollama.exe" serve
    timeout /t 3 /nobreak >nul
) else (
    echo [1/3] Serveur Ollama pret et operationnel.
)

set "SMOL_ROOT=%~dp0..\.."
for %%I in ("%SMOL_ROOT%") do set "SMOL_ROOT=%%~fI"

echo [Build] Verification et compilation du moteur Smolcoder...
call npm --prefix "%SMOL_ROOT%" run build
if errorlevel 1 (
    echo       ERREUR : le build Smolcoder a echoue.
    exit /b 1
)

:: 2. Verification du Hub Web Smolcoder
echo [2/3] Verification du moteur Smolcoder...
node -e "const h=require('%SMOL_ROOT%\\desktop\\hub-client.js'); h.ping(h.readHubRecord()).then(ok => process.exit(ok ? 0 : 1)).catch(() => process.exit(1));" >nul 2>&1
if errorlevel 1 (
    echo       Lancement du moteur Smolcoder en arriere-plan...
    start /min "" node "%SMOL_ROOT%\dist\index.js" --web
    timeout /t 3 /nobreak >nul
) else (
    echo       Moteur Smolcoder deja actif.
)

:: 3. Lancement de Smolcoder Desktop (Electron)
echo [3/3] Lancement de Smolcoder Desktop...
cd /d "%SMOL_ROOT%"
start "" "%SMOL_ROOT%\node_modules\electron\dist\electron.exe" "%SMOL_ROOT%\desktop"

echo.
echo ========================================================
echo   Smolcoder IDE Pro est lance avec succes !
echo ========================================================
timeout /t 2 /nobreak >nul
exit /b 0
