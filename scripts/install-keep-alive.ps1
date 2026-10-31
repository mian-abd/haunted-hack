# Registers the "Troska keep-alive" scheduled task: scripts/keep-alive.ps1 runs hidden at every logon, on battery too,
# with no time limit, and Task Scheduler restarts it if it ever exits. Then starts it now. Your user only, no admin needed.
#   powershell -ExecutionPolicy Bypass -File scripts\install-keep-alive.ps1            install (or update) and start
#   powershell -ExecutionPolicy Bypass -File scripts\install-keep-alive.ps1 -Remove    stop and remove it
param([switch]$Remove)
$name = 'Troska keep-alive'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
if ($Remove) { "removed '$name' (the backend processes it started keep running until you stop them)"; return }

$script = Join-Path $PSScriptRoot 'keep-alive.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Keeps the Troska backend (server, care team, cloudflared tunnel) running. See scripts/keep-alive.ps1.' | Out-Null
Start-ScheduledTask -TaskName $name
"installed and started '$name'. Logs: $env:LOCALAPPDATA\Troska\keep-alive.log"
