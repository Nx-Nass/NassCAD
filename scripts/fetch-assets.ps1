<#
    NASSCAD 4.7.0 — fetch-assets.ps1
    Downloads the two OpenCASCADE WASM binaries that are distributed as
    GitHub release assets instead of being committed to the repository.

    Usage:   .\scripts\fetch-assets.ps1
             .\scripts\fetch-assets.ps1 -Tag v4.7.0     # a specific release
             .\scripts\fetch-assets.ps1 -Force          # re-download
#>

[CmdletBinding()]
param(
    [string] $Repo = 'Nx-Nass/Nasscad_4.7.0',
    [string] $Tag  = 'latest',
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

# Repository root = parent of the scripts/ folder
$root = Split-Path -Parent $PSScriptRoot
$base = if ($Tag -eq 'latest') {
    "https://github.com/$Repo/releases/latest/download"
} else {
    "https://github.com/$Repo/releases/download/$Tag"
}

$assets = @(
    @{ Name = 'opencascade.wasm.data.js'; Size = 87818741 },
    @{ Name = 'opencascade.wasm.wasm';    Size = 65864037 }
)

Write-Host "NASSCAD 4.7.0 - fetching WASM assets from $base" -ForegroundColor Cyan

foreach ($a in $assets) {
    $dest = Join-Path $root $a.Name

    if ((Test-Path $dest) -and -not $Force) {
        $have = (Get-Item $dest).Length
        if ($have -eq $a.Size) {
            Write-Host "  [skip] $($a.Name) already present ($([math]::Round($have/1MB,1)) MB)" -ForegroundColor DarkGray
            continue
        }
        Write-Host "  [warn] $($a.Name) present but wrong size - re-downloading" -ForegroundColor Yellow
    }

    Write-Host "  [get ] $($a.Name) ($([math]::Round($a.Size/1MB,1)) MB)..." -NoNewline
    $tmp = "$dest.part"
    try {
        $pp = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri "$base/$($a.Name)" -OutFile $tmp -UseBasicParsing
        $ProgressPreference = $pp
    }
    catch {
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
        Write-Host ""
        throw "Download failed for $($a.Name): $($_.Exception.Message)"
    }

    $got = (Get-Item $tmp).Length
    if ($got -ne $a.Size) {
        Remove-Item $tmp -Force
        throw "$($a.Name): expected $($a.Size) bytes, got $got. Aborted."
    }

    Move-Item $tmp $dest -Force
    Write-Host " ok" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Serve the folder over HTTP, then open NASSCAD_V4_7_0.htm :" -ForegroundColor Cyan
Write-Host "  python -m http.server 8080" -ForegroundColor White
Write-Host "  http://localhost:8080/NASSCAD_V4_7_0.htm" -ForegroundColor White
