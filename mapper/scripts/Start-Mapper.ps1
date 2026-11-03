param([switch]$PreviewOnly)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Run from x64 PowerShell on Intel/AMD Windows.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 x64 first.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd was not found.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
if (-not $PreviewOnly) {
    if (-not $env:NDI_SDK_DIR) {
        foreach ($candidate in @('C:\Program Files\NDI\NDI SDK', 'C:\Program Files\NewTek\NDI SDK')) {
            if (Test-Path "$candidate\Include\Processing.NDI.Lib.h") { $env:NDI_SDK_DIR = $candidate; break }
        }
    }
    if (-not $env:NDI_SDK_DIR) { throw 'Install the standard Windows NDI SDK and set NDI_SDK_DIR. Use -PreviewOnly to test without NDI.' }
    & npm.cmd run native:build
    if ($LASTEXITCODE -ne 0) { throw 'Native receiver build failed. Check Visual Studio C++ Build Tools, CMake, and NDI_SDK_DIR.' }
    & node scripts/check-native.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Native receiver/runtime check failed. Install the official x64 runtime or set MAPPER_NDI_RUNTIME.' }
}
& npm.cmd run desktop
if ($LASTEXITCODE -ne 0) { throw 'Mapper did not launch successfully.' }
