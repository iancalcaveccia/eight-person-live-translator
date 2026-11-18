param(
  [Parameter(Mandatory = $true)][string]$Name,
  # Folder with es_from_gemini.wav (Spanish story, ~30 s) and pl_from_gemini.wav
  # (the same story in Polish); see docs/TEST_REPORT.md section 5g.
  [Parameter(Mandatory = $true)][string]$ClipsDir,
  [int]$Repeat = 24,
  [string]$AppUrl = "https://eight-person-live-translator.vercel.app",
  [string]$OutDir = "results"
)
# Long-session drift test: Ian (es-AR) and Partner (pl) 1 m apart, phones 0.5 s
# out of step (as measured in the owner's real session), the same 30 s + 30 s
# exchange repeated in one room. Prints delay and similarity per cycle; score
# the saved captions with: python scripts/long_session_score.py <out.json>
# Do not run test suites or other heavy work while it runs: cycles that are
# not published in real time (ratio > 1.1) are invalid.
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = Join-Path $OutDir "longsim-$Name.json"
$log = uv run --frozen python scripts/table_sim.py --app-url $AppUrl --people "Ian:es:es:es-AR,Partner:pl:pl" --bleed-db -20 --skew-ms "0,500" `
  --clip "es=$(Join-Path $ClipsDir 'es_from_gemini.wav')" --clip "pl=$(Join-Path $ClipsDir 'pl_from_gemini.wav')" --say "0:es:1:30" --say "1:pl:34:30" --repeat $Repeat --keep-captions --out $out 2>&1
if (-not (Test-Path $out) -or (Get-Item $out).LastWriteTime -lt (Get-Date).AddMinutes(-2)) { $log | Select-Object -Last 20; exit 1 }
$s = Get-Content $out -Raw -Encoding utf8 | ConvertFrom-Json
"[$Name] repeats {0} | realtime={1} ({2}) | heard {3}/{4} | first audio median {5}s | phantom {6}s, captions {7}" -f $s.repeats, $s.published_in_real_time, $s.publish_time_ratio, $s.translations_heard, $s.translations_expected, $s.first_audio_median_s, $s.phantom_total_s, $s.phantom_caption_segments_total
"first half: similarity {0}, first audio {1}s | second half: similarity {2}, first audio {3}s" -f $s.first_half.similarity_to_first, $s.first_half.first_audio_median_s, $s.second_half.similarity_to_first, $s.second_half.first_audio_median_s
$s.cycles | ForEach-Object { "  cycle {0,2} @ {1,4} min  x{2}  heard {3}  first {4}s  phantom {5}s  similarity {6}" -f $_.cycle, $_.minute, $_.publish_ratio, $_.heard, $_.first_audio_median_s, $_.phantom_s, $_.similarity_to_first }
