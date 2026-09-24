param([Parameter(Mandatory=$true)][string]$Path)
$b = [IO.File]::ReadAllBytes($Path)
if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
    Write-Output "BOM ok: $Path"
} else {
    [IO.File]::WriteAllBytes($Path, [byte[]](0xEF,0xBB,0xBF) + $b)
    Write-Output "BOM added: $Path"
}
