@echo off
title GMaps Scraper - Builder
color 0B
echo.
echo  ============================================
echo    GMaps Scraper - EXE Builder
echo  ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: Node.js is not installed!
    echo.
    echo  1. Go to https://nodejs.org
    echo  2. Download the LTS version ^(e.g. 20.x LTS^)
    echo  3. Install it, then re-run this script
    echo.
    pause
    exit /b 1
)
echo  [OK] Node.js:
node --version
echo.

:: Install npm packages
echo  [1/3] Installing packages...
echo        This also downloads Playwright + Chromium (~200MB). May take a few minutes.
echo.
call npm install
if %errorlevel% neq 0 (
    echo  ERROR: npm install failed. Check internet connection.
    pause
    exit /b 1
)

:: Explicitly install the Playwright Chromium browser
echo.
echo  [2/3] Downloading Chromium browser for Playwright...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo  WARNING: playwright install had issues but continuing...
)

:: Build the EXE
echo.
echo  [3/3] Building Windows installer EXE...
call npx electron-builder --win --x64
if %errorlevel% neq 0 (
    echo  ERROR: Build failed. See errors above.
    pause
    exit /b 1
)

echo.
echo  ============================================
echo   SUCCESS!
echo.
echo   Find your installer at:
echo   Desktop\New folder\GMaps Scraper Setup.exe
echo.
echo   That EXE bundles everything including
echo   Chromium - users need NOTHING extra.
echo  ============================================
echo.
pause
