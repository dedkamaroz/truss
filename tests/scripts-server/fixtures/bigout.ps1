# Prints about 3 MB to stdout, then lingers so the test can probe the server mid-run.
$line = 'x' * 1023
$w = [Console]::Out
for ($n = 0; $n -lt 3072; $n++) { $w.WriteLine($line) }
$w.Flush()
Start-Sleep -Seconds 2
exit 0
