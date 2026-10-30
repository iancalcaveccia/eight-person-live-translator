"use client";

/**
 * Device helpers. Browsers expose only labels for audio devices, so headset
 * detection is a label heuristic: we show it as a hint and always offer the
 * loopback self-test to confirm which microphone is really used.
 */

const HEADSET_RE =
  /bluetooth|airpods|buds|headset|hands-?free|\bhfp\b|\bbt\b|jabra|bose|sony|wh-|wf-|jbl|beats|plantronics|poly|shokz|aftershokz|soundcore|anker|pixel buds|galaxy buds|earbuds|earphones|auriculares|słuchawki/i;

export function looksLikeHeadset(label: string | undefined): boolean {
  return Boolean(label && HEADSET_RE.test(label));
}

export function canSelectAudioOutput(): boolean {
  if (typeof window === "undefined") return false;
  const ctxProto = (window.AudioContext?.prototype ?? {}) as { setSinkId?: unknown };
  const elProto = (window.HTMLMediaElement?.prototype ?? {}) as { setSinkId?: unknown };
  return typeof ctxProto.setSinkId === "function" || typeof elProto.setSinkId === "function";
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export async function listDevices(kind: "audioinput" | "audiooutput"): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === kind && d.deviceId !== "");
}

/** Keeps the screen on while in a gathering (iOS pauses the mic when it locks). */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private onVisibility = () => {
    if (this.wanted && document.visibilityState === "visible") void this.acquire();
  };

  get supported() {
    return typeof navigator !== "undefined" && "wakeLock" in navigator;
  }

  get held() {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  async enable() {
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    await this.acquire();
  }

  async disable() {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      /* already released */
    }
    this.sentinel = null;
  }

  private async acquire() {
    if (!this.supported || this.held) return;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
    } catch {
      // Denied (battery saver, not visible). Retried on next visibility change.
      this.sentinel = null;
    }
  }
}

/** Local-only loopback test: record a few seconds and play it back. Nothing is uploaded. */
export async function recordLoopback(deviceId: string | null, seconds = 3): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  try {
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.start();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    rec.stop();
    await done;
    return URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/** Short two-tone chime through the current output, to check the headset plays sound. */
export async function playTestTone(ctx: AudioContext): Promise<void> {
  if (ctx.state !== "running") await ctx.resume();
  const now = ctx.currentTime;
  for (const [i, f] of [660, 880].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, now + i * 0.25);
    gain.gain.linearRampToValueAtTime(0.25, now + i * 0.25 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.25 + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.25);
    osc.stop(now + i * 0.25 + 0.25);
  }
  await new Promise((r) => setTimeout(r, 600));
}
