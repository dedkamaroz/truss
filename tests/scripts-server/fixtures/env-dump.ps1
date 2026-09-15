# Records what the script can see of its own launch: env vars and the command lines of itself and its parent.
$ErrorActionPreference = 'Stop'
$me = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($me.ParentProcessId)"
$env_lines = Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }
$out = @("SELF=$($me.CommandLine)", "PARENT=$($parent.CommandLine)") + $env_lines
Set-Content -LiteralPath (Join-Path $env:TRUSS_OUTPUT_DIR 'launch.txt') -Value $out -Encoding UTF8
Copy-Item -LiteralPath $env:TRUSS_INPUTS_FILE -Destination (Join-Path $env:TRUSS_OUTPUT_DIR 'inputs-copy.json')
Write-Output "cwd=$((Get-Location).Path)"
