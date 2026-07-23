@echo off
REM ============================================================================
REM  Supervisor simples pra Windows: compila e roda o bot, reiniciando sozinho
REM  se ele cair (crash/OOM/queda de rede prolongada). Zero dependencia.
REM  Uso: dar duplo-clique ou rodar "start-forever.bat" no terminal.
REM  Ctrl+C para parar de vez. Para producao seria, alternativa mais robusta: NSSM.
REM ============================================================================
cd /d "%~dp0"

echo [supervisor] Compilando (npm run build)...
call npm run build
if errorlevel 1 (
  echo [supervisor] Build falhou. Corrija e rode de novo.
  pause
  exit /b 1
)

:loop
echo [supervisor] %date% %time% - iniciando bot...
node dist/index.js
echo [supervisor] %date% %time% - bot saiu (codigo %errorlevel%). Reiniciando em 5s... (Ctrl+C para parar)
timeout /t 5 /nobreak >nul
goto loop
