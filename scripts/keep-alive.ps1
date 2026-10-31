# Keeps Troska's backend up on this Windows laptop: server/ (:8787), care-team/ (:8788) and the cloudflared tunnel to :8787.
# Every 30 s it checks each piece and restarts whatever is down. A restarted quick tunnel gets a new trycloudflare URL, so it
# then re-points everything at it: ElevenLabs (bun run el:setup), the server (restarted for the new webhook secret) and the
# Vercel site (the URL in web/vercel.json, then vercel deploy --prod). The old tunnel is stopped only after that.
# To switch tunnels on purpose, create the file %LOCALAPPDATA%\Troska\rotate-tunnel.
# Started at logon by the "Troska keep-alive" scheduled task (scripts/install-keep-alive.ps1). Logs: %LOCALAPPDATA%\Troska\
# Keys (OPENAI_API_KEY, ELEVENLABS_API_KEY, TERSE_API_KEY, TWILIO_*) come from the Windows user environment, as in the README.
param([int]$Every = 30)

$root = Split-Path $PSScriptRoot -Parent
$logs = Join-Path $env:LOCALAPPDATA 'Troska'
New-Item -ItemType Directory -Force $logs | Out-Null
$bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$cloudflared = @((Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source, (Join-Path $env:USERPROFILE '.local\bin\cloudflared.exe')) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$vercel = @((Get-Command vercel.cmd -ErrorAction SilentlyContinue).Source, (Join-Path $env:APPDATA 'npm\vercel.cmd')) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$vercelJson = Join-Path $root 'web\vercel.json'
$utf8 = New-Object Text.UTF8Encoding $false
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest's progress bar slows every check
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Log($msg) {
  $file = Join-Path $logs 'keep-alive.log'
  if ((Test-Path $file) -and (Get-Item $file).Length -gt 1MB) { Move-Item $file "$file.1" -Force }
  Add-Content $file "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
}

# One watchdog at a time. A second one (the logon task while a copy started by hand runs) waits here and takes over
# when the first one exits.
$mutex = New-Object Threading.Mutex($false, 'Local\TroskaKeepAlive')
try { [void]$mutex.WaitOne() } catch [Threading.AbandonedMutexException] { } # abandoned = the first one was killed; ours now

foreach ($k in 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'TERSE_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN') {
  $v = [Environment]::GetEnvironmentVariable($k, 'User'); if ($v) { Set-Item "Env:$k" $v }
}
$env:AUTO_DIAL = '1' # a due check-in rings the elder's phone
Remove-Item Env:TERSE_FAKE -ErrorAction SilentlyContinue

# HTTP status of a GET, or 0 when nothing answered.
function Status($url) {
  try { return [int](Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 10).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 } }
}

function WaitFor($what, $test, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i += 2) { if (& $test) { return $true }; Start-Sleep 2 }
  Log "$what did not come up within $seconds s"; return $false
}

$pieces = [ordered]@{
  'server'    = @{ dir = 'server'; port = 8787; health = 'http://127.0.0.1:8787/api/call/mode' }
  'care-team' = @{ dir = 'care-team'; port = 8788; health = 'http://127.0.0.1:8788/health' }
}
$started = @{}

function Restart-Piece($name) {
  $p = $pieces[$name]
  if ($started[$name]) { & taskkill.exe /PID $started[$name].Id /T /F 2>&1 | Out-Null }
  Get-NetTCPConnection -LocalPort $p.port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  $out = Join-Path $logs "$name.log"; $err = Join-Path $logs "$name.err.log"
  foreach ($f in $out, $err) { if (Test-Path $f) { Move-Item $f "$f.1" -Force } }
  $started[$name] = Start-Process -FilePath $bun -ArgumentList 'run', 'start' -WorkingDirectory (Join-Path $root $p.dir) -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  Log "started $name (pid $($started[$name].Id))"
  [void](WaitFor $name { (Status $p.health) -eq 200 } 45)
}

function Tunnel-Url {
  try { return ((Get-Content $vercelJson -Raw | ConvertFrom-Json).rewrites | Where-Object { $_.source -eq '/api/:path*' }).destination -replace '/api/:path\*$', '' }
  catch { return '' }
}

function Tunnel-Running { [bool](Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match ':8787' }) }

# Starts a new quick tunnel next to the old one (which keeps serving until everything points at the new one).
# Returns @{ url; id }, with url '' if cloudflared never printed one.
function Start-Tunnel {
  Get-ChildItem $logs -Filter 'tunnel-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item -ErrorAction SilentlyContinue
  $log = Join-Path $logs "tunnel-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
  $proc = Start-Process -FilePath $cloudflared -ArgumentList 'tunnel', '--url', 'http://localhost:8787' -WindowStyle Hidden -RedirectStandardError $log -RedirectStandardOutput "$log.out" -PassThru
  Log "started cloudflared (pid $($proc.Id), log $log)"
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep 1
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { return @{ url = $m.Matches[0].Value; id = $proc.Id } }
  }
  return @{ url = ''; id = $proc.Id }
}

function Stop-Tunnels($except) {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match ':8787' -and $_.ProcessId -ne $except } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Log "stopped old cloudflared (pid $($_.ProcessId))" }
}

# Points ElevenLabs and the Vercel site at a new tunnel URL, then restarts the server for the new webhook secret.
function Repoint($url) {
  $old = Tunnel-Url
  Log "re-pointing ElevenLabs and Vercel from $old to $url"
  $env:PUBLIC_URL = $url
  Push-Location (Join-Path $root 'server')
  & $bun run el:setup *>> (Join-Path $logs 'repoint.log')
  $ok = $LASTEXITCODE -eq 0
  Pop-Location
  Remove-Item Env:PUBLIC_URL
  Log "el:setup $(if ($ok) { 'done' } else { "failed (exit $LASTEXITCODE), see repoint.log" })"
  if ($old) { [IO.File]::WriteAllText($vercelJson, (Get-Content $vercelJson -Raw).Replace($old, $url), $utf8) }
  Push-Location (Join-Path $root 'web')
  & $vercel deploy --prod --yes *>> (Join-Path $logs 'repoint.log')
  Log "vercel deploy $(if ($LASTEXITCODE -eq 0) { 'done' } else { "failed (exit $LASTEXITCODE), see repoint.log" })"
  Pop-Location
  Restart-Piece 'server'
}

Log "keep-alive started (checks every $Every s; tunnel $(Tunnel-Url))"
$tunnelMisses = 0
while ($true) {
  try {
    foreach ($name in $pieces.Keys) {
      if ((Status $pieces[$name].health) -ne 200) { Log "$name is down"; Restart-Piece $name }
    }
    # The tunnel counts as up when our server answers through it (403 without the team code is fine).
    $url = Tunnel-Url
    $code = if ($url) { Status "$url/api/call/mode" } else { 0 }
    $serverUp = (Status $pieces['server'].health) -eq 200
    $rotate = Join-Path $logs 'rotate-tunnel' # create this file to switch to a new tunnel on purpose
    if (Test-Path $rotate) { Remove-Item $rotate; $tunnelMisses = 99; Log 'tunnel switch requested' }
    elseif (-not (Tunnel-Running)) { $tunnelMisses = 99; Log 'cloudflared is not running' }
    elseif ($serverUp -and ($code -eq 0 -or $code -ge 500)) { $tunnelMisses++; Log "tunnel $url answered $code (miss $tunnelMisses)" }
    else { $tunnelMisses = 0 }
    # Only replace the tunnel when the internet itself is reachable; otherwise the old one comes back on its own.
    if ($tunnelMisses -ge 3 -and (Status 'https://www.cloudflare.com/cdn-cgi/trace') -eq 200) {
      $t = Start-Tunnel
      if ($t.url -and (WaitFor 'new tunnel' { $c = Status "$($t.url)/api/call/mode"; $c -gt 0 -and $c -lt 500 } 90)) {
        Repoint $t.url; Stop-Tunnels $t.id; $tunnelMisses = 0
      } else {
        Log 'the new tunnel never answered; trying again next round'
        Stop-Process -Id $t.id -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { Log "error: $($_.Exception.Message)" }
  Start-Sleep $Every
}
