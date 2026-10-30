# Generates synthetic speech WAV fixtures for the browser E2E tests (Windows SAPI voices).
# These are SYNTHETIC English test signals for pipeline/latency plumbing with the mock
# translator — not a substitute for real consented human speech in EN/PL/ES.
$dir = Join-Path $PSScriptRoot "fixtures"
New-Item -ItemType Directory -Force $dir | Out-Null
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

function Make($file, $voice, $ssml) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($voice)
  $s.SetOutputToWaveFile((Join-Path $dir $file), $fmt)
  $s.SpeakSsml($ssml)
  $s.Dispose()
}

$mono = "Hello, my name is Ian Luca. I am from Argentina and I live in Krakow. Tonight we are having dinner with the whole family, and I want to tell you a long story about how we found this apartment, how the neighbours welcomed us, and why the bakery on the corner makes the best bread in the city. Every morning I walk there, I buy two loaves, and I talk with the baker about football, the weather, and the price of flour. He always asks about my mother in Buenos Aires, and I always promise him that one day she will visit and taste his bread."
Make "monologue_30s.wav" "Microsoft Zira Desktop" "<speak version='1.0' xml:lang='en-US'>$mono</speak>"
Make "monologue_b_30s.wav" "Microsoft David Desktop" "<speak version='1.0' xml:lang='en-US'>Good evening everyone. I wanted to say how happy I am that we could all sit together at the same table tonight. The soup is excellent, the wine is from a small vineyard near Mendoza, and after dinner we will play cards like we used to when we were children. Please, tell me about your trip, how long was the flight, and did you manage to sleep at all on the plane?</speak>"
Make "interjection_at_8s.wav" "Microsoft David Desktop" "<speak version='1.0' xml:lang='en-US'><break time='8000ms'/>What? Seriously?<break time='10000ms'/><break time='10000ms'/></speak>"
Make "silence_30s.wav" "Microsoft David Desktop" "<speak version='1.0' xml:lang='en-US'><break time='10000ms'/><break time='10000ms'/><break time='10000ms'/></speak>"
Get-ChildItem $dir -Filter *.wav | ForEach-Object { "{0}  {1:N1} s" -f $_.Name, (($_.Length - 44) / 96000) }
