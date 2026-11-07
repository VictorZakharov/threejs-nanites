# One-time setup of a test PC (the reference low-end AMD PC) so the dev machine can run the harness on it over SSH.
# Run once on that PC, in PowerShell as administrator:
#   powershell -ExecutionPolicy Bypass -File setup-device.ps1
# It turns on Windows' OpenSSH server (key sign-in only, the dev machine's key below), installs Node and Git with winget,
# and clones the repo into the user's folder with its packages. The harness there runs Chrome headless: nothing shows on
# the screen, and the PC stays usable. Each step prints its number, what it does and how long it took; the slow ones
# show their own progress. Safe to run again: done steps are skipped. Everything is also logged to setup-device.log.
#Requires -RunAsAdministrator
param([string]$Repo = "$env:USERPROFILE\threejs-nanites")
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'setup-device.log'
Start-Transcript -Path $log -Append | Out-Null
# (the dev machine's public key: ~/.ssh/living-room-pc.pub there)
$key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPwY+QCBJFjoIgtVJs+i+1CZ14Lkd5K8HXXIwEfchgdu claude-dev-to-living-room-pc'
$total = 8
$started = Get-Date

function Step([int]$n, [string]$what, [scriptblock]$do) {
  $t = Get-Date
  Write-Host ''
  Write-Host ("[{0}/{1}] {2}  ({3:HH:mm:ss})" -f $n, $total, $what, $t) -ForegroundColor Cyan
  try {
    & $do
    Write-Host ("      done in {0:N0} s" -f ((Get-Date) - $t).TotalSeconds) -ForegroundColor Green
  } catch {
    Write-Host ''
    Write-Host "FAILED at step ${n}: $what" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "The full log is in ${log}: paste the end of it to Claude." -ForegroundColor Yellow
    Stop-Transcript | Out-Null
    exit 1
  }
}
# (an external program: its own output and progress stay on screen; a non-zero exit code fails the step)
function Run([string]$exe, [string[]]$arguments, [int[]]$ok = @(0)) {
  Write-Host "      > $exe $($arguments -join ' ')" -ForegroundColor DarkGray
  & $exe @arguments
  if ($ok -notcontains $LASTEXITCODE) { throw "$exe exited with code $LASTEXITCODE" }
}

Step 1 'OpenSSH server: install (Windows feature; can take a few minutes, DISM shows a percentage)' {
  $state = (Get-WindowsCapability -Online -Name 'OpenSSH.Server*').State
  if ($state -eq 'Installed') { Write-Host '      already installed'; return }
  # (Add-WindowsCapability shows nothing while it downloads: DISM prints its progress)
  Run 'dism.exe' @('/Online', '/Add-Capability', '/CapabilityName:OpenSSH.Server~~~~0.0.1.0') @(0, 3010)
}

Step 2 'OpenSSH server: start it, and start it with Windows' {
  Start-Service sshd # (writes its default config on the first start)
  Set-Service sshd -StartupType Automatic
  Write-Host "      sshd is $((Get-Service sshd).Status)"
}

Step 3 'OpenSSH server: key sign-in only, the dev machine''s key' {
  $conf = "$env:ProgramData\ssh\sshd_config"
  if (-not (Select-String -Path $conf -Pattern '^PasswordAuthentication no' -Quiet)) {
    Set-Content $conf ("PasswordAuthentication no`r`n" + (Get-Content $conf -Raw))
    Write-Host '      password sign-in off'
  }
  # (an administrator's keys are read from ProgramData, a standard user's from their profile: both, so either works)
  $admin = "$env:ProgramData\ssh\administrators_authorized_keys"
  if (-not (Test-Path $admin) -or -not (Select-String -Path $admin -SimpleMatch $key -Quiet)) { Add-Content $admin $key }
  Run 'icacls.exe' @($admin, '/inheritance:r', '/grant', 'Administrators:F', '/grant', 'SYSTEM:F')
  $userKeys = "$env:USERPROFILE\.ssh\authorized_keys"
  New-Item -ItemType Directory -Force (Split-Path $userKeys) | Out-Null
  if (-not (Test-Path $userKeys) -or -not (Select-String -Path $userKeys -SimpleMatch $key -Quiet)) { Add-Content $userKeys $key }
  Write-Host '      key added'
}

Step 4 'Firewall: SSH (port 22) from the home network' {
  if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) { Write-Host '      rule exists'; }
  else { New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private | Out-Null }
  Restart-Service sshd
}

$nodeDir = "$env:ProgramFiles\nodejs"
$gitExe = "$env:ProgramFiles\Git\cmd\git.exe"
Step 5 'Node.js (winget shows a progress bar)' {
  if (Test-Path "$nodeDir\node.exe") { Write-Host "      already there: $(& "$nodeDir\node.exe" --version)"; return }
  # (winget: 0 installed; -1978335189 already installed)
  Run 'winget' @('install', '-e', '--id', 'OpenJS.NodeJS.LTS', '--accept-source-agreements', '--accept-package-agreements') @(0, -1978335189)
}

Step 6 'Git (winget shows a progress bar)' {
  if (Test-Path $gitExe) { Write-Host "      already there: $(& $gitExe --version)"; return }
  Run 'winget' @('install', '-e', '--id', 'Git.Git', '--accept-source-agreements', '--accept-package-agreements') @(0, -1978335189)
}
$env:Path = "$nodeDir;$env:ProgramFiles\Git\cmd;$env:Path"

Step 7 "The repo, in $Repo (git shows its progress)" {
  if (Test-Path "$Repo\.git") { Write-Host '      already cloned: updating'; Run $gitExe @('-C', $Repo, 'pull', '--ff-only') ; return }
  Run $gitExe @('clone', '--progress', 'https://github.com/VictorZakharov/threejs-nanites.git', $Repo)
}

Step 8 'Its packages (npm install; a minute or two, the bar shows it going)' {
  Push-Location $Repo
  try { Run "$nodeDir\npm.cmd" @('install', '--no-audit', '--no-fund', '--progress=true') } finally { Pop-Location }
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host ("All done in {0:N0} s." -f ((Get-Date) - $started).TotalSeconds) -ForegroundColor Green
Write-Host "Tell Claude: user $env:USERNAME, host $env:COMPUTERNAME, address $ip, repo $Repo" -ForegroundColor Green
Stop-Transcript | Out-Null
