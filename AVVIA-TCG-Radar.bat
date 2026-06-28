@echo off
title TCG Radar - Server Expo
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
echo ===============================================
echo    TCG RADAR  -  avvio server Expo
echo.
echo    1) Aspetta che compaia il QR code qui sotto
echo    2) Apri l'app "Expo Go" sul telefono
echo    3) Scansiona il QR (telefono e PC sulla
echo       stessa rete Wi-Fi!)
echo    4) Per fermare: premi  Ctrl+C  in questa finestra
echo ===============================================
echo.
npx expo start --lan
echo.
echo (Server fermato) - premi un tasto per chiudere.
pause >nul
