@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem  Baixa os resultados e grava dados-meta.json na mesma pasta.
rem
rem  Dois cliques  -> usa o token e a conta guardados no .env,
rem                   e o periodo do dia 1 do mes corrente ate hoje.
rem  Linha de comando, para outro periodo ou outra conta:
rem      puxar.bat --desde 2026-08-01 --ate 2026-08-27
rem      puxar.bat --conta act_1234567890 --desde 2026-08-01

where node >nul 2>nul
if errorlevel 1 goto semnode

if not exist .env if "%~1"=="" goto semenv

node puxar-meta.mjs %*
if errorlevel 1 goto falhou

echo.
echo   ================================================================
echo     Arraste o dados-meta.json desta pasta para o painel no
echo     navegador. O arquivo e lido no seu computador e nao sai daqui.
echo   ================================================================
echo.
pause
exit /b

:semenv
echo.
echo   Ainda nao ha token guardado. De dois cliques em conectar.bat
echo   primeiro - ele pede o token e escolhe a conta.
echo.
pause
exit /b 1

:falhou
echo.
echo   A puxada falhou. A mensagem acima diz o motivo.
echo.
pause
exit /b 1

:semnode
echo.
echo   Node nao encontrado nesta maquina.
echo   Instale em https://nodejs.org - versao LTS - feche esta janela
echo   e abra outra depois de instalar.
echo.
pause
exit /b 1
