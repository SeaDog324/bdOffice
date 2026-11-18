@echo off
rem bigdogoffice launcher for the packaged Windows app: <install>\resources\cli\bigdogoffice.cmd
setlocal
set ELECTRON_RUN_AS_NODE=1
if exist "%~dp0..\..\bigdogoffice.exe" (
  "%~dp0..\..\bigdogoffice.exe" "%~dp0bigdogoffice.cjs" %*
) else (
  node "%~dp0..\dist\bigdogoffice.cjs" %*
)
set cliExitCode=%errorlevel%
endlocal & exit /b %cliExitCode%
