@echo off
rem Start NewfieCad on Windows: serves this folder and opens your browser.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 serve.py %*) else (python serve.py %*)
pause
