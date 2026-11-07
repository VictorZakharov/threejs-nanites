# One-time setup of a test PC (the reference low-end AMD PC) so the dev machine can run the harness on it over SSH:
# `npm run harness -- --remote=<host> ...` (tools/AGENTS.md). Run once on that PC, in PowerShell as administrator:
#   powershell -ExecutionPolicy Bypass -File setup-device.ps1
# It turns on Windows' OpenSSH server (key sign-in only, the dev machine's key below), installs Node and Git with winget,
# and clones the repo into the user's folder with its packages. The harness there runs Chrome headless: nothing shows on
# the screen, and the PC stays usable.
#Requires -RunAsAdministrator
param([string]$Repo = "$env:USERPROFILE\threejs-nanites")
$ErrorActionPreference = 'Stop'
# (the dev machine's public key: ~/.ssh/living-room-pc.pub there)
$key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPwY+QCBJFjoIgtVJs+i+1CZ14Lkd5K8HXXIwEfchgdu claude-dev-to-living-room-pc'

Write-Host 'OpenSSH server...'
if ((Get-WindowsCapability -Online -Name 'OpenSSH.Server*').State -ne 'Installed') {
  Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
}
Start-Service sshd # (writes its default config on the first start)
Set-Service sshd -StartupType Automatic
$conf = "$env:ProgramData\ssh\sshd_config"
if (-not (Select-String -Path $conf -Pattern '^PasswordAuthentication no' -Quiet)) {
  # (keys only: no password guessing from the network)
  $text = Get-Content $conf -Raw
  Set-Content $conf ("PasswordAuthentication no`r`n" + $text)
}
# (an administrator's keys are read from ProgramData, a standard user's from their profile: both, so either works)
$admin = "$env:ProgramData\ssh\administrators_authorized_keys"
if (-not (Test-Path $admin) -or -not (Select-String -Path $admin -SimpleMatch $key -Quiet)) { Add-Content $admin $key }
icacls $admin /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
$userKeys = "$env:USERPROFILE\.ssh\authorized_keys"
New-Item -ItemType Directory -Force (Split-Path $userKeys) | Out-Null
if (-not (Test-Path $userKeys) -or -not (Select-String -Path $userKeys -SimpleMatch $key -Quiet)) { Add-Content $userKeys $key }
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private | Out-Null
}
Restart-Service sshd

Write-Host 'Node and Git...'
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements
$git, $npm = "$env:ProgramFiles\Git\cmd\git.exe", "$env:ProgramFiles\nodejs\npm.cmd"
$env:Path = "$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd;$env:Path"

Write-Host "The repo in $Repo..."
if (-not (Test-Path "$Repo\.git")) { & $git clone https://github.com/VictorZakharov/threejs-nanites.git $Repo }
Push-Location $Repo
& $npm install --no-audit --no-fund
Pop-Location

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host "Done. Tell Claude: user $env:USERNAME, host $env:COMPUTERNAME, address $ip, repo $Repo"
