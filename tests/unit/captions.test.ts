import { describe, expect, it } from "vitest";
import { CaptionStore, type CaptionChunk } from "@/client/media/captions";

const chunk = (over: Partial<CaptionChunk> = {}): CaptionChunk => ({
  speakerId: "ana",
  kind: "translation",
  targetLang: "es",
  sourceLang: "pl",
  seg: "0",
  final: false,
  text: "",
  ...over,
});

describe("CaptionStore", () => {
  it("appends chunks of one segment into one caption", () => {
    const store = new CaptionStore("es");
    store.add(chunk({ text: "hola," }), 1);
    store.add(chunk({ text: "¿qué tal?" }), 2);
    store.add(chunk({ final: true }), 3);
    expect(store.list().map((e) => e.text)).toEqual(["hola, ¿qué tal?"]);
  });

  it("removes a segment the worker retracts (a neighbour's voice under the wrong name)", () => {
    const store = new CaptionStore("es");
    store.add(chunk({ seg: "0", text: "Dzień dobry" }), 1);
    store.add(chunk({ seg: "0", final: true }), 2);
    store.add(chunk({ seg: "1", text: "words that were really mine" }), 3);
    const before = store.getVersion();
    store.add(chunk({ seg: "1", final: true, retract: true }), 4);
    expect(store.list().map((e) => e.text)).toEqual(["Dzień dobry"]);
    expect(store.getVersion()).toBeGreaterThan(before);
    // A later segment opens normally.
    store.add(chunk({ seg: "2", text: "ok" }), 5);
    expect(store.list().map((e) => e.text)).toEqual(["Dzień dobry", "ok"]);
  });

  it("ignores retractions for other languages and unknown segments", () => {
    const store = new CaptionStore("es");
    store.add(chunk({ seg: "0", text: "hola" }), 1);
    store.add(chunk({ seg: "0", targetLang: "en", retract: true, final: true }), 2);
    store.add(chunk({ seg: "7", retract: true, final: true }), 3);
    expect(store.list().map((e) => e.text)).toEqual(["hola"]);
  });
});
