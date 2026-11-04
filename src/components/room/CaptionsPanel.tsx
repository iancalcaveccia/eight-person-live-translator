"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { CaptionEntry, CaptionStore } from "@/client/media/captions";
import { speakerColor } from "./Sheet";

const VISIBLE = 40;

export default function CaptionsPanel({
  store,
  names,
  colors,
  showOriginal,
  sameLanguageSpeakers,
}: {
  store: CaptionStore;
  names: Map<string, string>;
  colors: Map<string, number>;
  showOriginal: boolean;
  /** Speakers heard in the original language: show their source text as the caption. */
  sameLanguageSpeakers: Set<string>;
}) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  const endRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(() => {
    void version;
    const all = store.list();
    const out: CaptionEntry[] = [];
    for (const e of all) {
      if (e.kind === "translation") out.push(e);
      else if (sameLanguageSpeakers.has(e.speakerId) || showOriginal) out.push(e);
    }
    return out.slice(-VISIBLE);
  }, [store, version, showOriginal, sameLanguageSpeakers]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entries.length, version]);

  if (entries.length === 0) {
    return (
      <p className="small faint" style={{ textAlign: "center", padding: "8px 0" }}>
        Live captions appear here as people talk.
      </p>
    );
  }

  return (
    <div className="captions" aria-live="polite" aria-relevant="additions text">
      {entries.map((e) => (
        <div key={e.id} className="caption" data-final={e.final} style={{ ["--pc" as string]: speakerColor(colors.get(e.speakerId)) }}>
          <div className="caption-bar" />
          <div>
            <div className="caption-who">
              {names.get(e.speakerId) ?? "Someone"}
              {e.kind === "source" && <span className="faint"> · original{e.lang ? ` (${e.lang})` : ""}</span>}
            </div>
            <div className={e.kind === "source" && !sameLanguageSpeakers.has(e.speakerId) ? "caption-orig" : "caption-text"}>
              {e.text}
            </div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
