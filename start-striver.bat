@echo off
chcp 65001 >nul
title Khoi dong Striver AIOS
cd /d "%~dp0"

echo Bat Striver AIOS chay NEN - khong con cua so den (port 7777)...
REM Viec tat instance cu + chay server AN giao het cho start-striver.vbs (cua so an hoan toan).
REM Log ghi vao server\striver.log (mo file do neu can xem loi). Tat server: stop-striver.bat.
wscript //nologo start-striver.vbs

echo.
echo Da bat. Cho ~10 giay roi mo http://localhost:7777 va bam Ctrl+Shift+R.
echo (Tat server: chay stop-striver.bat. Xem loi: mo file server\striver.log)
timeout /t 4 >nul
