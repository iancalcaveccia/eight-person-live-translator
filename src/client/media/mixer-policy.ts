/**
 * Listener-side mixing policy for overlapping speakers (spec 05). Pure and
 * deterministic: given which streams are active and for how long, return a
 * target gain per stream. The Web Audio layer smooths gains over time.
 *
 * Defaults are configurable starting points, not validated acoustic optima.
 */

export type MixMode = "natural" | "focus" | "equal";

export interface StreamState {
  key: string;
  speakerId: string;
  kind: "native" | "translation";
  active: boolean;
  /** How long the current activity run has lasted (ms); 0 when inactive. */
  activeForMs: number;
  /** User per-speaker volume, 0..1.5. */
  userGain: number;
  /** Locally muted by the listener. */
  muted: boolean;
}

export interface MixParams {
  /** Activity shorter than this counts as an interjection (spec: ~0.3–3 s). */
  interjectionMaxMs: number;
  /** A stream must have been talking this much longer to be ducked for an interjection. */
  interjectionLeadMs: number;
  /** Ducking applied to the longer stream during a short interjection (spec: 5–9 dB). */
  interjectionDuckDb: number;
  /** Ducking for streams beyond the two foreground voices when ≥3 overlap. */
  crowdDuckDb: number;
  /** Ducking for non-focused speakers in focus mode. */
  focusDuckDb: number;
  /** Max simultaneously un-ducked voices. */
  maxForeground: number;
}

export const DEFAULT_MIX_PARAMS: MixParams = {
  interjectionMaxMs: 3000,
  interjectionLeadMs: 1000,
  interjectionDuckDb: 7,
  crowdDuckDb: 12,
  focusDuckDb: 12,
  maxForeground: 2,
};

export interface MixInput {
  mode: MixMode;
  focusSpeakerId: string | null;
  translationVolume: number; // 0..1.5
  originalVolume: number; // 0..1.5
  streams: StreamState[];
  params?: MixParams;
}

export const dbToGain = (db: number) => Math.pow(10, -Math.abs(db) / 20);

export interface MixDecision {
  gain: number;
  /** Why this gain was chosen (for diagnostics UI and tests). */
  reason: "muted" | "full" | "interjection-duck" | "crowd-duck" | "focus-duck" | "idle";
}

export function computeMix(input: MixInput): Map<string, MixDecision> {
  const p = input.params ?? DEFAULT_MIX_PARAMS;
  const out = new Map<string, MixDecision>();
  const base = (s: StreamState) =>
    (s.kind === "translation" ? input.translationVolume : input.originalVolume) * s.userGain;

  const audible = input.streams.filter((s) => !s.muted);
  for (const s of input.streams) {
    if (s.muted) out.set(s.key, { gain: 0, reason: "muted" });
  }

  const active = audible.filter((s) => s.active);
  // Idle streams keep their base gain so a new onset is never attenuated.
  for (const s of audible) if (!s.active) out.set(s.key, { gain: base(s), reason: "idle" });

  // Focus: while the focused person is talking, everyone else is quieter.
  // When they are silent, fall through to the natural rules.
  const focusId = input.mode === "focus" ? input.focusSpeakerId : null;
  if (focusId && active.some((s) => s.speakerId === focusId)) {
    for (const s of active) {
      if (s.speakerId === focusId) out.set(s.key, { gain: base(s), reason: "full" });
      else out.set(s.key, { gain: base(s) * dbToGain(p.focusDuckDb), reason: "focus-duck" });
    }
    return out;
  }

  if (input.mode === "equal" || active.length <= 1) {
    for (const s of active) out.set(s.key, { gain: base(s), reason: "full" });
    return out;
  }

  // ---- natural mode, ≥2 active voices ---------------------------------
  const ducked = new Map<string, MixDecision["reason"]>();

  // 1. Short interjections duck the voices that were already talking.
  const interjectors = active.filter((s) => s.activeForMs < p.interjectionMaxMs);
  for (const i of interjectors) {
    for (const other of active) {
      if (other.key === i.key) continue;
      if (other.activeForMs >= i.activeForMs + p.interjectionLeadMs && !interjectors.includes(other)) {
        ducked.set(other.key, "interjection-duck");
      }
    }
  }

  // 2. Crowd control: keep at most `maxForeground` voices un-ducked.
  //    Priority: newest interjections first (they are short and easy to miss),
  //    then the longest-running main speaker.
  const undecided = active.filter((s) => !ducked.has(s.key));
  if (undecided.length > p.maxForeground) {
    const ranked = [...undecided].sort((a, b) => {
      const ai = a.activeForMs < p.interjectionMaxMs ? 0 : 1;
      const bi = b.activeForMs < p.interjectionMaxMs ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return ai === 0 ? a.activeForMs - b.activeForMs : b.activeForMs - a.activeForMs;
    });
    for (const s of ranked.slice(p.maxForeground)) ducked.set(s.key, "crowd-duck");
  }

  for (const s of active) {
    const why = ducked.get(s.key);
    if (!why) out.set(s.key, { gain: base(s), reason: "full" });
    else {
      const db = why === "interjection-duck" ? p.interjectionDuckDb : p.crowdDuckDb;
      out.set(s.key, { gain: base(s) * dbToGain(db), reason: why });
    }
  }
  return out;
}

/**
 * One-pole gain smoother: fast attack when ducking, slow release when
 * restoring (spec: ~80–150 ms attack, ~400–700 ms release).
 */
export function smoothGain(current: number, target: number, dtMs: number, attackMs = 100, releaseMs = 600): number {
  const tau = target < current ? attackMs : releaseMs;
  const alpha = 1 - Math.exp(-dtMs / tau);
  const next = current + (target - current) * alpha;
  // Snap when within ~0.05 dB: inaudible, and avoids endless tiny updates.
  return Math.abs(next - target) < 0.005 ? target : next;
}

/**
 * Voice-activity detector on a level stream with hysteresis, so brief dips
 * between words don't end an "activity run".
 */
export class ActivityDetector {
  active = false;
  runStartedAt = 0;
  private aboveSince: number | null = null;
  private belowSince: number | null = null;

  constructor(
    private threshold = 0.012, // RMS (~ -38 dBFS)
    private onsetMs = 60,
    private releaseMs = 450,
  ) {}

  update(rms: number, nowMs: number): { active: boolean; activeForMs: number; startedNow: boolean } {
    let startedNow = false;
    if (rms >= this.threshold) {
      this.belowSince = null;
      if (this.aboveSince === null) this.aboveSince = nowMs;
      if (!this.active && nowMs - this.aboveSince >= this.onsetMs) {
        this.active = true;
        this.runStartedAt = this.aboveSince;
        startedNow = true;
      }
    } else {
      this.aboveSince = null;
      if (this.active) {
        if (this.belowSince === null) this.belowSince = nowMs;
        if (nowMs - this.belowSince >= this.releaseMs) this.active = false;
      }
    }
    return { active: this.active, activeForMs: this.active ? nowMs - this.runStartedAt : 0, startedNow };
  }
}
