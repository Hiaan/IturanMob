@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem  Testa a conexao com o Meta e lista as contas de anuncios do token.
rem  Pode ser executado com dois cliques.

where node >nul 2>nul
if errorlevel 1 goto semnode

if exist .env goto rodar

echo.
echo   Cole abaixo o token de acesso do Meta ^(comeca com EAA^).
echo   Como gerar o token esta no README.md.
echo.
set /p TOKEN=Token: 
if not defined TOKEN goto semtoken
> .env echo META_ACCESS_TOKEN=%TOKEN%
echo.
echo   Token guardado no arquivo .env desta pasta.

:rodar
echo.
node puxar-meta.mjs --contas
echo.
echo   Copie o act_... da conta que voce quer e rode:  puxar.bat --conta act_...
echo.
pause
exit /b

:semtoken
echo.
echo   Nenhum token informado. Rode de novo quando tiver o token em maos.
echo.
pause
exit /b 1

:semnode
echo.
echo   Node nao encontrado nesta maquina.
echo   Instale em https://nodejs.org ^(versao LTS^), feche esta janela
echo   e abra outra depois de instalar.
echo.
pause
exit /b 1
