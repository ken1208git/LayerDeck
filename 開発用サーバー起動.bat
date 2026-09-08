@echo off
chcp 65001 >nul
cd /d "%~dp0"
title LayerDeck

py -3 server.py %*
if errorlevel 9009 goto trypython
goto end

:trypython
python server.py %*

:end
echo.
echo LayerDeck を終了しました。
pause
