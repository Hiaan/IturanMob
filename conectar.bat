@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem  Testa a conexao com o Meta, lista as contas de anuncios e guarda
rem  token + conta escolhida no arquivo .env. Depois disso, puxar.bat
rem  funciona com dois cliques, sem argumento nenhum.

where node >nul 2>nul
if errorlevel 1 goto semnode

if exist .env goto temtoken

echo.
echo   Cole abaixo o token de acesso do Meta - comeca com EAA.
echo   Como gerar o token esta no README.md.
echo.
set /p TOKEN=Token: 
if not defined TOKEN goto semtoken
> .env echo META_ACCESS_TOKEN=%TOKEN%
echo.
echo   Token guardado no arquivo .env desta pasta.

:temtoken
echo.
node puxar-meta.mjs --contas
if errorlevel 1 goto falhou

findstr /b /i "META_AD_ACCOUNT_ID=" .env >nul 2>nul
if not errorlevel 1 goto jatem

echo.
echo   Copie acima o act_... da conta que voce quer acompanhar
echo   e cole aqui. Para escolher depois, so teclar Enter.
echo.
set /p CONTA=Conta: 
if not defined CONTA goto semconta
>> .env echo META_AD_ACCOUNT_ID=%CONTA%
echo.
echo   ================================================================
echo     Pronto. A partir de agora, e so dar dois cliques em puxar.bat
echo   ================================================================
echo.
pause
exit /b

:jatem
echo.
echo   A conta ja esta guardada no .env. De dois cliques em puxar.bat.
echo.
pause
exit /b

:semconta
echo.
echo   Nenhuma conta escolhida. Rode este arquivo de novo quando quiser,
echo   ou passe direto:  puxar.bat --conta act_1234567890
echo.
pause
exit /b

:semtoken
echo.
echo   Nenhum token informado. Rode de novo quando tiver o token em maos.
echo.
pause
exit /b 1

:falhou
echo.
echo   O teste de conexao falhou. A mensagem acima diz o motivo.
echo   Para trocar o token, apague o arquivo .env e rode isto de novo.
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
