$cats = @("disciplines","web-engines","genres","workflows","other-engines")
foreach ($c in $cats) {
    Write-Output ("=== " + $c + " ===")
    $api = "https://api.github.com/repos/gamedev-skills/awesome-gamedev-agent-skills/contents/skills/$c"
    try {
        $r = Invoke-WebRequest -Uri $api -UseBasicParsing -Headers @{ "User-Agent" = "probe" } -TimeoutSec 30
        $items = $r.Content | ConvertFrom-Json
        foreach ($i in $items) {
            if ($i.type -eq "dir") { Write-Output ("  " + $i.name) }
        }
    } catch {
        Write-Output ("  ERR: " + $_.Exception.Message)
    }
}