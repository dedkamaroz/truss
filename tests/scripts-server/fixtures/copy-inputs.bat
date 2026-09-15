@echo off
rem Copies every input listed in TRUSS_INPUTS_FILE into TRUSS_OUTPUT_DIR and writes result.txt.
rem Filenames are only ever read from the JSON file, never expanded by cmd.
echo run %TRUSS_RUN_ID% starting
powershell.exe -NoProfile -NonInteractive -Command "$items = Get-Content -Raw -LiteralPath $env:TRUSS_INPUTS_FILE | ConvertFrom-Json; foreach ($i in @($items)) { Copy-Item -LiteralPath $i.path -Destination (Join-Path $env:TRUSS_OUTPUT_DIR $i.filename); Write-Output ('copied ' + $i.id) }"
if errorlevel 1 exit /b 1
> "%TRUSS_OUTPUT_DIR%\result.txt" echo batch ok
echo batch done
exit /b 0
