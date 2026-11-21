import { describe, expect, it } from "vitest";
import { hearingModeFor, wantsAgentTrack, wantsNativeMic, type ListenerPrefs } from "@/client/media/routing";
import { LatencyTracker, percentile } from "@/client/media/latency";
import { parseTranslationTrackName, translationTrackName } from "@/lib/contract";

const speakers = new Map([
  ["es1", { id: "es1", speakLang: "es" }],
  ["pl1", { id: "pl1", speakLang: "pl" }],
  ["en1", { id: "en1", speakLang: "en" }],
  ["auto1", { id: "auto1", speakLang: "auto" }],
]);

const polish = (over: Partial<ListenerPrefs> = {}): ListenerPrefs => ({
  listenLang: "pl",
  nativePassthrough: true,
  originalFor: new Set(),
  ...over,
});

describe("subscription routing", () => {
  it("hears same-language speakers natively and others translated, never both", () => {
    for (const sp of speakers.values()) {
      const native = wantsNativeMic(sp, polish());
      const tx = wantsAgentTrack(translationTrackName(sp.id, "pl"), speakers, polish());
      expect(native && tx).toBe(false);
    }
    expect(wantsNativeMic(speakers.get("pl1")!, polish())).toBe(true);
    expect(wantsAgentTrack("tx:es1:pl", speakers, polish())).toBe(true);
    expect(wantsAgentTrack("tx:en1:pl", speakers, polish())).toBe(true);
  });

  it("ignores translation tracks for other target languages", () => {
    expect(wantsAgentTrack("tx:es1:en", speakers, polish())).toBe(false);
  });

  it("routes auto-detect speakers through translation for everyone", () => {
    expect(hearingModeFor(speakers.get("auto1")!, polish())).toBe("translation");
    expect(wantsAgentTrack("tx:auto1:pl", speakers, polish())).toBe(true);
  });

  it("lets the listener choose the original voice for a speaker", () => {
    const prefs = polish({ originalFor: new Set(["es1"]) });
    expect(wantsNativeMic(speakers.get("es1")!, prefs)).toBe(true);
    expect(wantsAgentTrack("tx:es1:pl", speakers, prefs)).toBe(false);
  });

  it("can silence same-language headset passthrough for people at the same table", () => {
    const prefs = polish({ nativePassthrough: false });
    expect(hearingModeFor(speakers.get("pl1")!, prefs)).toBe("none");
    expect(wantsNativeMic(speakers.get("pl1")!, prefs)).toBe(false);
  });

  it("swaps the primary track for a comparison provider track on request", () => {
    const prefs = polish({ compareFor: new Map([["es1", "openai"]]) });
    expect(wantsAgentTrack("tx:es1:pl", speakers, prefs)).toBe(false);
    expect(wantsAgentTrack("txc:es1:pl:openai", speakers, prefs)).toBe(true);
    expect(wantsAgentTrack("txc:es1:pl:gemini", speakers, prefs)).toBe(false);
  });

  it("ignores tracks for people not in the room", () => {
    expect(wantsAgentTrack("tx:ghost:pl", speakers, polish())).toBe(false);
  });

  it("parses track names strictly", () => {
    expect(parseTranslationTrackName("tx:abc:pl")).toEqual({ speakerId: "abc", targetLang: "pl", comparison: false });
    expect(parseTranslationTrackName("txc:abc:pl:openai")).toMatchObject({ provider: "openai", comparison: true });
    expect(parseTranslationTrackName("tx:a:b:c")).toBeNull();
    expect(parseTranslationTrackName("microphone")).toBeNull();
  });
});

describe("latency tracking", () => {
  it("matches worker onsets to audible translation", () => {
    const t = new LatencyTracker();
    t.onWorkerOnset("ian", 1000);
    t.onWorkerOnset("ian", 1500); // second onset before audio keeps the earliest
    expect(t.onAudible("ian", 3200, false)?.ms).toBe(2200);
    expect(t.onAudible("ian", 4000, false)).toBeNull(); // already matched
    t.onWorkerOnset("kasia", 5000);
    t.onAudible("kasia", 6800, true);
    expect(t.summary()).toEqual({ count: 2, p50: 1800, p95: 2200 });
    expect(t.summary((s) => s.overlap).count).toBe(1);
  });

  it("drops stale onsets", () => {
    const t = new LatencyTracker(15_000);
    t.onWorkerOnset("ian", 0);
    t.expire(20_000);
    expect(t.onAudible("ian", 20_100, false)).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});
