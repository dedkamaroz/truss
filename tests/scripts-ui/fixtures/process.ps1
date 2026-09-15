$ErrorActionPreference = 'Stop'
# Copies each chosen input to TRUSS_OUTPUT_DIR with a "processed-" prefix and writes summary.txt.
Write-Output "run $env:TRUSS_RUN_ID started"
Start-Sleep -Milliseconds 2500
$items = @(Get-Content -Raw -LiteralPath $env:TRUSS_INPUTS_FILE | ConvertFrom-Json)
foreach ($i in $items) {
  Copy-Item -LiteralPath $i.path -Destination (Join-Path $env:TRUSS_OUTPUT_DIR ("processed-" + $i.filename))
  Write-Output "processed $($i.filename)"
}
Set-Content -LiteralPath (Join-Path $env:TRUSS_OUTPUT_DIR 'summary.txt') -Value "inputs: $($items.Count)" -NoNewline
Write-Output "done: $($items.Count) inputs"
exit 0
