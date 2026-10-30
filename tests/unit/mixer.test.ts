import { describe, expect, it } from "vitest";
import {
  ActivityDetector,
  computeMix,
  dbToGain,
  smoothGain,
  type StreamState,
} from "@/client/media/mixer-policy";

const s = (key: string, active: boolean, activeForMs = 0, extra: Partial<StreamState> = {}): StreamState => ({
  key,
  speakerId: key,
  kind: "translation",
  active,
  activeForMs: active ? activeForMs : 0,
  userGain: 1,
  muted: false,
  ...extra,
});

const mix = (streams: StreamState[], mode: "natural" | "focus" | "equal" = "natural", focus: string | null = null) =>
  computeMix({ mode, focusSpeakerId: focus, translationVolume: 1, originalVolume: 1, streams });

describe("natural conversation mixing", () => {
  it("plays a single speaker at full volume", () => {
    const m = mix([s("ian", true, 12_000), s("kasia", false)]);
    expect(m.get("ian")).toEqual({ gain: 1, reason: "full" });
    expect(m.get("kasia")?.reason).toBe("idle");
  });

  it("ducks the long monologue ~7 dB during a short interjection, keeping it audible", () => {
    // Spec case: Ian talks 20 s, Kasia says "Co?! Serio?!" at second 8.
    const m = mix([s("ian", true, 8_000), s("kasia", true, 400)]);
    expect(m.get("kasia")).toEqual({ gain: 1, reason: "full" });
    const ian = m.get("ian")!;
    expect(ian.reason).toBe("interjection-duck");
    expect(ian.gain).toBeCloseTo(dbToGain(7), 5);
    expect(ian.gain).toBeGreaterThan(0.3); // ducked, never muted
  });

  it("stops treating a competitor as an interjection once it lasts beyond the window", () => {
    const m = mix([s("ian", true, 12_000), s("kasia", true, 4_000)]);
    expect(m.get("ian")?.gain).toBe(1);
    expect(m.get("kasia")?.gain).toBe(1);
  });

  it("two people starting together are both kept at full volume", () => {
    const m = mix([s("a", true, 500), s("b", true, 300)]);
    expect(m.get("a")?.gain).toBe(1);
    expect(m.get("b")?.gain).toBe(1);
  });

  it("with three or more voices keeps at most two in the foreground and never mutes the rest", () => {
    const m = mix([s("main", true, 15_000), s("second", true, 9_000), s("third", true, 7_000), s("fourth", true, 6_000)]);
    const reasons = [...m.values()].map((d) => d.reason);
    expect(reasons.filter((r) => r === "full")).toHaveLength(2);
    for (const d of m.values()) expect(d.gain).toBeGreaterThan(0);
    // Longest-running main speaker stays in the foreground.
    expect(m.get("main")?.reason).toBe("full");
  });

  it("prioritises multiple short interjections over sustained side talk", () => {
    const m = mix([s("main", true, 15_000), s("side", true, 8_000), s("q1", true, 500), s("q2", true, 900)]);
    expect(m.get("q1")?.reason).toBe("full");
    expect(m.get("q2")?.reason).toBe("full");
    expect(m.get("main")?.gain).toBeLessThan(1);
    expect(m.get("side")?.gain).toBeLessThan(1);
    expect(m.get("main")?.gain).toBeGreaterThan(0);
  });

  it("respects local mutes and per-speaker volume", () => {
    const m = mix([s("a", true, 5_000, { muted: true }), s("b", true, 5_000, { userGain: 0.5 })]);
    expect(m.get("a")).toEqual({ gain: 0, reason: "muted" });
    expect(m.get("b")?.gain).toBe(0.5);
  });

  it("uses translation vs original master volumes", () => {
    const m = computeMix({
      mode: "natural",
      focusSpeakerId: null,
      translationVolume: 0.8,
      originalVolume: 0.4,
      streams: [s("t", true, 5000), s("n", false, 0, { kind: "native" })],
    });
    expect(m.get("t")?.gain).toBeCloseTo(0.8);
    expect(m.get("n")?.gain).toBeCloseTo(0.4);
  });
});

describe("focus and equal modes", () => {
  it("focus ducks others only while the focused speaker talks", () => {
    const talking = mix([s("ian", true, 3_000), s("kasia", true, 6_000)], "focus", "ian");
    expect(talking.get("ian")?.gain).toBe(1);
    expect(talking.get("kasia")?.reason).toBe("focus-duck");
    const silent = mix([s("ian", false), s("kasia", true, 6_000)], "focus", "ian");
    expect(silent.get("kasia")?.gain).toBe(1);
  });

  it("equal mode never ducks", () => {
    const m = mix([s("a", true, 9_000), s("b", true, 200), s("c", true, 300)], "equal");
    for (const d of m.values()) expect(d.gain).toBe(1);
  });
});

describe("gain smoothing and activity detection", () => {
  it("attacks fast and releases slowly", () => {
    let g = 1;
    for (let t = 0; t < 150; t += 50) g = smoothGain(g, 0.45, 50);
    expect(g).toBeLessThan(0.6); // mostly ducked within ~150 ms
    let r = 0.45;
    for (let t = 0; t < 150; t += 50) r = smoothGain(r, 1, 50);
    expect(r).toBeLessThan(0.75); // restore takes longer
    for (let t = 0; t < 3000; t += 50) r = smoothGain(r, 1, 50);
    expect(r).toBe(1);
  });

  it("needs ~60 ms of sound to start and bridges short gaps between words", () => {
    const d = new ActivityDetector(0.01, 60, 450);
    expect(d.update(0.05, 0).active).toBe(false);
    const on = d.update(0.05, 70);
    expect(on.active).toBe(true);
    expect(on.startedNow).toBe(true);
    expect(d.update(0.0, 300).active).toBe(true); // short pause
    expect(d.update(0.05, 500).activeForMs).toBe(500); // same run continues
    d.update(0.0, 600);
    expect(d.update(0.0, 1100).active).toBe(false);
  });
});
