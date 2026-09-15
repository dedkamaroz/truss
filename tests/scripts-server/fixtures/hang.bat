@echo off
rem Starts a child cmd whose command line carries this script's folder (the test puts a unique marker in it),
rem which in turn runs a long ping. Cancel/timeout must kill the whole tree.
echo hanging
cmd.exe /d /c "ping -n 120 127.0.0.1 > nul & rem %~dp0"
exit /b 0
