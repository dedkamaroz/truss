@echo off
rem Runs for about two minutes unless cancelled.
echo long job started
ping -n 120 127.0.0.1 > nul
exit /b 0
