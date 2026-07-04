@echo off
chcp 65001 >nul
title Khoi dong Javis OS
cd /d "%~dp0"

echo Tat instance cu (neu co)...
call stop-javis.bat

echo Bat Javis OS chay nen (port 7777)...
REM Chay server trong 1 cua so RIENG, thu nho - dong cua so nay = tat server.
REM Log ghi vao server\javis.log (mo file do neu can xem loi).
start "Javis OS" /min cmd /c ".venv\Scripts\python.exe server\main.py > server\javis.log 2>&1"

echo.
echo Da bat. Cho ~10 giay roi mo http://localhost:7777 va bam Ctrl+Shift+R.
echo (Tat server: chay stop-javis.bat, hoac dong cua so "Javis OS" da thu nho.)
timeout /t 4 >nul
