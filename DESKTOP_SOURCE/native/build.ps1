param(
    [string]$OcctRoot = $env:OCCT_ROOT,
    [string]$ManifoldRoot = $env:MANIFOLD_ROOT,
    [string]$VsDevCmd = $env:VSDEVCMD
)
$ErrorActionPreference = 'Stop'
if (!$OcctRoot -or !$ManifoldRoot) { throw 'Set OCCT_ROOT and MANIFOLD_ROOT to your dependency install directories.' }
if (!$VsDevCmd) { $VsDevCmd = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat' }
if (!(Test-Path -LiteralPath $VsDevCmd)) { throw 'Set VSDEVCMD to the Visual Studio x64 developer environment script.' }
$desktopRoot = Split-Path -Parent $PSScriptRoot
$nativeFile = Join-Path $PSScriptRoot 'nasscad_medusa.cpp'
$occtLib = Join-Path $OcctRoot 'win64\vc14\lib'
$occtBin = Join-Path $OcctRoot 'win64\vc14\bin'
$manifoldLib = Join-Path $ManifoldRoot 'lib\manifoldc.lib'
$outputPath = Join-Path $desktopRoot 'runtime\medusa'
$buildPath = Join-Path $desktopRoot 'work\native'
New-Item -ItemType Directory -Path $outputPath,$buildPath -Force | Out-Null
$libraries = (Get-ChildItem -LiteralPath $occtLib -Filter '*.lib').FullName
if (!$libraries -or !(Test-Path -LiteralPath $manifoldLib)) { throw 'Dependency libraries not found. Build OCCT and Manifold for MSVC x64 first.' }
$compiler = 'cl /nologo /std:c++17 /EHsc /O2 /MD /utf-8 /DNOMINMAX /I"' + $OcctRoot + '\inc" /I"' + $ManifoldRoot + '\include" "' + $nativeFile + '" /Fo"' + $buildPath + '\medusa-internal.obj" /Fe"' + $outputPath + '\Medusa_Internal.exe" /link ' + (($libraries | ForEach-Object { '"' + $_ + '"' }) -join ' ') + ' "' + $manifoldLib + '" ws2_32.lib shell32.lib ole32.lib'
& cmd.exe /d /c ('"' + $VsDevCmd + '" -arch=x64 -host_arch=x64 >nul && ' + $compiler)
if ($LASTEXITCODE -ne 0) { throw 'Native MEDUSA compilation failed.' }
Get-ChildItem -LiteralPath $occtBin -Filter '*.dll' | Copy-Item -Destination $outputPath
Get-ChildItem -LiteralPath (Join-Path $ManifoldRoot 'bin') -Filter '*.dll' | Copy-Item -Destination $outputPath
Write-Output "MEDUSA built in $outputPath. Copy the matching oneTBB/hwloc and MSVC runtime DLLs there before packaging."
