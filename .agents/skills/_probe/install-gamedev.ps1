# Installs the gamedev-skills/awesome-gamedev-agent-skills skills that are
# relevant to a Babylon.js sailing/combat game, into BOTH the project-local
# .agents/skills and the global ~/.codegpt/skills.
#
# Relevance filter: naval physics + feel + camera + procedural world + the
# systems this game actually has (networking, UI, AI ships, audio, shaders).
# Skipped deliberately: engine-specific skills for engines we do not use
# (phaser, pixijs, threejs, bevy, love2d, pygame, roblox) and genre packs that
# do not match (card, platformer, puzzle, roguelike, visual-novel, tower-defense).

$repo = "gamedev-skills/awesome-gamedev-agent-skills"
$branch = "main"

# category/name pairs
$wanted = @(
    "disciplines/physics-tuning",
    "disciplines/game-feel",
    "disciplines/camera-systems",
    "disciplines/procedural-gen",
    "disciplines/shader-programming",
    "disciplines/performance-optimization",
    "disciplines/game-ai",
    "disciplines/ai-behavior-trees-utility-ai",
    "disciplines/input-systems",
    "disciplines/game-ui-ux",
    "disciplines/level-design",
    "disciplines/audio-design",
    "disciplines/save-systems",
    "genres/survival-crafting",
    "workflows/prototype-fast"
)

$roots = @(
    "c:\Users\fred\Documents\GitHub\HighSeaz\.agents\skills",
    "C:\Users\fred\.codegpt\skills"
)

# Files we fetch per skill. Everything else in the repo (demos, tests) is skipped.
$fileNames = @("SKILL.md", "LICENSE")

$ok = 0
$fail = 0

foreach ($root in $roots) {
    Write-Output ("### " + $root)
    foreach ($w in $wanted) {
        $name = $w.Split("/")[-1]
        $dest = Join-Path $root $name
        New-Item -ItemType Directory -Path $dest -Force | Out-Null

        $got = $false
        foreach ($f in $fileNames) {
            $url = "https://raw.githubusercontent.com/$repo/$branch/skills/$w/$f"
            $target = Join-Path $dest $f
            try {
                Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -Headers @{ "User-Agent" = "codegpt" } -TimeoutSec 30
                $got = $true
            }
            catch {
                # LICENSE is optional; SKILL.md is not.
                if ($f -eq "SKILL.md") {
                    Write-Output ("  FAIL " + $name + " : " + $_.Exception.Message)
                }
            }
        }

        if ($got) {
            $sz = (Get-Item (Join-Path $dest "SKILL.md")).Length
            Write-Output ("  ok   " + $name.PadRight(34) + $sz + " bytes")
            $ok++
        }
        else {
            $fail++
        }
    }
}

Write-Output ""
Write-Output ("installed: " + $ok + "   failed: " + $fail)