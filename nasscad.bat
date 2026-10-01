@echo off
setlocal EnableExtensions
title NASSCAD

rem ============================================================================
rem  NASSCAD launcher - starts the MEDUSA engine, then opens NASSCAD.
rem
rem    nasscad.bat          start the engine and open NASSCAD
rem    nasscad.bat stop     stop the engine
rem    nasscad.bat noweb    start the engine only
rem
rem  Keep this file in the same folder as the engine and the NASSCAD page.
rem  https://www.nasscad.com
rem ============================================================================

set "HERE=%~dp0"
set "ENGINE=Nasscad_Medusa_Engine_3.1.exe"
set "PORT=8765"

if /i "%~1"=="stop" goto :stop

rem --- locate the NASSCAD page: first NASSCAD_*.htm next to this script -------
set "PAGE="
for %%F in ("%HERE%NASSCAD_*.htm") do if not defined PAGE set "PAGE=%%~fF"
if not defined PAGE (
  echo [ERROR] No NASSCAD_*.htm found in this folder.
  echo         Keep nasscad.bat next to the NASSCAD page.
  echo.
  pause
  exit /b 1
)

if not exist "%HERE%%ENGINE%" (
  echo [ERROR] %ENGINE% not found in this folder.
  echo         The engine and the page must stay together.
  echo.
  pause
  exit /b 1
)

rem --- already running? ------------------------------------------------------
tasklist /fi "imagename eq %ENGINE%" 2>nul | find /i "%ENGINE%" >nul
if not errorlevel 1 (
  echo [ OK ] MEDUSA is already running.
  goto :open
)

echo [ .. ] Starting MEDUSA engine...
start "NASSCAD MEDUSA" /min /d "%HERE%" "%HERE%%ENGINE%"

rem --- wait until the engine accepts connections (10 s max) ------------------
rem     TCP probe rather than netstat parsing: netstat state labels are
rem     translated on localized Windows, this is not.
powershell -NoProfile -Command "$n=0; while($n -lt 20){ try{ $c=New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 500; $n++ } }; exit 1"
if errorlevel 1 (
  echo [WARN] The engine did not open port %PORT% within 10 seconds.
  echo        Opening NASSCAD anyway - it will run browser-only,
  echo        which works, just slower on large assemblies.
) else (
  echo [ OK ] MEDUSA is listening on port %PORT%.
)

:open
if /i "%~1"=="noweb" goto :done
echo [ .. ] Opening NASSCAD in your default browser...
start "" "%PAGE%"

:done
echo.
echo NASSCAD is running. You can close this window, the engine keeps running.
echo To stop the engine later:  nasscad.bat stop
echo.
timeout /t 5 /nobreak >nul
exit /b 0

:stop
taskkill /im "%ENGINE%" /f >nul 2>&1
if errorlevel 1 (echo MEDUSA was not running.) else (echo MEDUSA stopped.)
timeout /t 3 /nobreak >nul
exit /b 0
