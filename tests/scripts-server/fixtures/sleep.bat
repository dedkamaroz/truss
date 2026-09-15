@echo off
rem Roughly 3 seconds.
ping -n 4 127.0.0.1 > nul
echo slept
exit /b 0
