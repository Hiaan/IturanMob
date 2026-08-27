@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem  Baixa os resultados e grava dados-meta.json.
rem  Uso:  puxar.bat --conta act_1234567890 --desde 2026-08-01
rem  Sem argumentos, usa o .env e o mes corrente.

where node >nul 2>nul
if errorlevel 1 goto semnode

node puxar-meta.mjs %*
echo.
pause
exit /b

:semnode
echo.
echo   Node nao encontrado nesta maquina.
echo   Instale em https://nodejs.org ^(versao LTS^), feche esta janela
echo   e abra outra depois de instalar.
echo.
pause
exit /b 1
