/**
 * Client-side latency measurement without recording audio.
 *
 * The worker sends `onset` when it detects speech at its input. When the
 * matching translated track becomes audible on this device we record
 * `now - onsetReceivedAt`: worker-detected speech → audible translation on
 * this phone. It excludes the speaker's uplink (typically 50–300 ms), which
 * the report states explicitly instead of hiding it.
 */

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export interface LatencySample {
  speakerId: string;
  ms: number;
  /** Another translated voice was already audible when this one started. */
  overlap: boolean;
  at: number;
}

export class LatencyTracker {
  private pendingOnsets = new Map<string, number>();
  samples: LatencySample[] = [];
  serverSamples: { speakerId: string; target: string; ms: number }[] = [];

  constructor(
    private maxMatchMs = 15_000,
    private maxSamples = 500,
  ) {}

  onWorkerOnset(speakerId: string, nowMs: number) {
    // Keep the earliest unmatched onset for a speaker.
    if (!this.pendingOnsets.has(speakerId)) this.pendingOnsets.set(speakerId, nowMs);
  }

  onWorkerFirstAudio(speakerId: string, target: string, ms: number) {
    this.serverSamples.push({ speakerId, target, ms });
    if (this.serverSamples.length > this.maxSamples) this.serverSamples.shift();
  }

  /** Called when the translated stream for `speakerId` becomes audible. */
  onAudible(speakerId: string, nowMs: number, overlap: boolean): LatencySample | null {
    const onset = this.pendingOnsets.get(speakerId);
    if (onset === undefined) return null;
    this.pendingOnsets.delete(speakerId);
    const ms = nowMs - onset;
    if (ms < 0 || ms > this.maxMatchMs) return null;
    const s = { speakerId, ms, overlap, at: nowMs };
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return s;
  }

  /** Expire onsets that never produced audible translation (e.g. bleed, silence). */
  expire(nowMs: number) {
    for (const [k, t] of this.pendingOnsets) if (nowMs - t > this.maxMatchMs) this.pendingOnsets.delete(k);
  }

  summary(filter?: (s: LatencySample) => boolean) {
    const ms = this.samples.filter(filter ?? (() => true)).map((s) => s.ms).sort((a, b) => a - b);
    return { count: ms.length, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
  }

  serverSummary() {
    const ms = this.serverSamples.map((s) => s.ms).sort((a, b) => a - b);
    return { count: ms.length, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
  }

  reset() {
    this.pendingOnsets.clear();
    this.samples = [];
    this.serverSamples = [];
  }
}
