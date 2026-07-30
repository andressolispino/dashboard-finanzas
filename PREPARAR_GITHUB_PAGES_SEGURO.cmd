@echo off
setlocal
title Preparar dashboard cifrado para GitHub Pages
cd /d "%~dp0"
set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python.exe"
"%PYTHON_EXE%" "%~dp0scripts\build_encrypted_pages.py"
echo.
pause
