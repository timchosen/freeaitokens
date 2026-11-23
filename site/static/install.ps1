# Installs the FreeAITokens desktop app on Windows from its latest GitHub release.
# It downloads the installer to your temp folder and runs it. Nothing else is changed.
# Source and explanation: https://freeaitokens.co/install-script
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads many times slower
$url = 'https://github.com/timchosen/freeaitokens/releases/latest/download/FreeAITokens-windows.exe'
$file = Join-Path $env:TEMP 'FreeAITokens-windows.exe'
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
Write-Host 'Running the installer. Windows may ask you to confirm: choose More info, then Run anyway.'
Start-Process -FilePath $file -Wait
Remove-Item $file -ErrorAction SilentlyContinue
Write-Host 'Done. FreeAITokens is in your Start menu and system tray.'
}
