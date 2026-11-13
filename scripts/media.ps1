# Streams the current Windows media session (Spotify, browser, Apple Music, etc.)
# as one JSON object per line, and accepts "toggle" / "next" / "prev" on stdin.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, [Type]$type) {
    if ($null -eq $op) { return $null }
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    if ($task.Wait(3000)) { return $task.Result }
    return $null
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$mgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
    [Console]::Out.Flush()
}

$mgr = Await ($mgrType::RequestAsync()) $mgrType
if (-not $mgr) { Emit @{ ok = $false; error = 'Media session manager unavailable' }; exit 1 }

$script:artKey = ''
$script:artTries = 0

function Get-Art($props) {
    try {
        if (-not $props.Thumbnail) { return $null }
        $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType
        if (-not $stream) { return $null }
        $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $bytes = $ms.ToArray()
        $net.Dispose(); $ms.Dispose()
        if ($bytes.Length -lt 64) { return $null }
        $mime = 'image/png'
        if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $mime = 'image/jpeg' }
        return "data:$mime;base64," + [Convert]::ToBase64String($bytes)
    } catch { return $null }
}

function Poll {
    $s = $mgr.GetCurrentSession()
    if (-not $s) { Emit @{ ok = $true; has = $false }; return }
    $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
    if (-not $p) { Emit @{ ok = $true; has = $false }; return }
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $status = [string]$info.PlaybackStatus
    $pos = $tl.Position.TotalSeconds
    $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds
    if ($status -eq 'Playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
        $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
    }
    if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
    $key = "$($p.Title)|$($p.Artist)|$($s.SourceAppUserModelId)"
    $o = @{
        ok = $true; has = $true; key = $key
        title = [string]$p.Title; artist = [string]$p.Artist; album = [string]$p.AlbumTitle
        app = [string]$s.SourceAppUserModelId; status = $status
        pos = [math]::Round([math]::Max(0, $pos), 1); dur = [math]::Round([math]::Max(0, $dur), 1)
    }
    if ($key -ne $script:artKey) {
        $art = Get-Art $p
        if ($art -or $script:artTries -ge 4) {
            $script:artKey = $key; $script:artTries = 0
            $o.art = $art; $o.artChanged = $true
        } else { $script:artTries++ }
    }
    Emit $o
}

function Do-Command([string]$cmd) {
    $s = $mgr.GetCurrentSession()
    if (-not $s) { return }
    switch ($cmd) {
        'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
        'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    }
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $reader.ReadLineAsync()
$tick = 10
while ($true) {
    if ($pending.IsCompleted) {
        $line = $pending.Result
        if ($null -eq $line) { exit 0 }
        Do-Command ($line.Trim())
        $pending = $reader.ReadLineAsync()
        Start-Sleep -Milliseconds 250
        $tick = 10
    }
    if ($tick -ge 10) { $tick = 0; Poll }
    Start-Sleep -Milliseconds 100
    $tick++
}
