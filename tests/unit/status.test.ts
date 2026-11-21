import { describe, expect, it } from "vitest";
import { computeStatus, INTERPRETER_MISSING_MS } from "@/components/room/status";
import { DEFAULT_SETTINGS } from "@/client/prefs";
import type { MediaSnapshot } from "@/client/media/session";

const snap = (over: Partial<MediaSnapshot> = {}): MediaSnapshot => ({
  status: "connected",
  error: null,
  roomName: "grp_x",
  groupId: "g",
  epoch: 1,
  micWanted: false,
  micLive: false,
  micPermission: "unknown",
  canPlayAudio: true,
  agentPresent: true,
  budgetState: "ok",
  translation: {},
  quality: "good",
  lastSwitchMs: null,
  humans: [
    { id: "a", name: "A", speakLang: "es", listenLang: "es", esRegion: "", color: 1, speaking: false, micMuted: false, micPublished: true },
  ],
  inputDeviceLabel: null,
  inputIsHeadset: false,
  notice: null,
  noiseFilterActive: "standard",
  meSpeaking: false,
  connectedAt: 0,
  ...over,
});

describe("room status pill", () => {
  it("says live with the measured delay", () => {
    expect(computeStatus(snap(), DEFAULT_SETTINGS, "pl", true, 2100, 1000).label).toBe("Live · ~2.1 s behind");
  });

  it("does not need the interpreter when everyone shares my language", () => {
    expect(computeStatus(snap({ agentPresent: false }), DEFAULT_SETTINGS, "es", true, null, 99_999).label).toBe("Live");
  });

  it("shows a cold start, then admits the interpreter is missing", () => {
    expect(computeStatus(snap({ agentPresent: false }), DEFAULT_SETTINGS, "pl", true, null, 5_000).label).toBe("Starting interpreter…");
    const late = computeStatus(snap({ agentPresent: false }), DEFAULT_SETTINGS, "pl", true, null, INTERPRETER_MISSING_MS + 1);
    expect(late).toMatchObject({ tone: "err", label: "Interpreter unavailable" });
  });

  it("reports budget stops and delays", () => {
    expect(computeStatus(snap(), DEFAULT_SETTINGS, "pl", false, null, 0).label).toBe("Translation paused");
    const delayed = snap({ translation: { "a:pl": { speaker: "a", target: "pl", provider: "gemini", state: "delayed", backlogMs: 3000, updatedAt: 0 } } });
    expect(computeStatus(delayed, DEFAULT_SETTINGS, "pl", true, null, 0).label).toBe("Delayed");
  });
});
