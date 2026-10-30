"use client";

/**
 * Bounded, in-memory caption buffer (never persisted). Chunks arrive as
 * separate text streams (CONTRACT 5.1); we append them into one entry per
 * (speaker, kind, segment) and keep only the most recent entries.
 */

export interface CaptionEntry {
  id: string;
  speakerId: string;
  kind: "translation" | "source";
  lang: string;
  text: string;
  final: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface CaptionChunk {
  speakerId: string;
  kind: "translation" | "source";
  targetLang: string;
  sourceLang: string;
  seg: string;
  final: boolean;
  text: string;
}

const MAX_ENTRIES = 160;

export class CaptionStore {
  private entries: CaptionEntry[] = [];
  private open = new Map<string, CaptionEntry>(); // `${speaker}|${kind}|${seg}`
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private listenLang: string) {}

  setListenLang(lang: string) {
    if (lang !== this.listenLang) {
      this.listenLang = lang;
      this.clear();
    }
  }

  add(c: CaptionChunk, now = Date.now()) {
    // Only keep translations into my language; source text is always kept
    // (shown on demand as "original").
    if (c.kind === "translation" && c.targetLang !== this.listenLang) return;
    const key = `${c.speakerId}|${c.kind}|${c.seg}`;
    let entry = this.open.get(key);
    const text = c.text;
    if (!entry) {
      if (!text.trim() && c.final) return;
      entry = {
        id: `${key}|${now}`,
        speakerId: c.speakerId,
        kind: c.kind,
        lang: c.kind === "translation" ? c.targetLang : c.sourceLang,
        text: "",
        final: false,
        startedAt: now,
        updatedAt: now,
      };
      this.open.set(key, entry);
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) {
        const dropped = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        for (const d of dropped) this.open.delete(`${d.speakerId}|${d.kind}|${d.id.split("|")[2]}`);
      }
    }
    if (text) entry.text = joinText(entry.text, text);
    if (c.sourceLang && c.kind === "source") entry.lang = c.sourceLang;
    entry.updatedAt = now;
    if (c.final) {
      entry.final = true;
      this.open.delete(key);
    }
    this.bump();
  }

  /** Close segments that went quiet (provider may not send a final marker). */
  sweep(now = Date.now(), idleMs = 4000) {
    let changed = false;
    for (const [k, e] of this.open) {
      if (now - e.updatedAt > idleMs) {
        e.final = true;
        this.open.delete(k);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  clear() {
    this.entries = [];
    this.open.clear();
    this.bump();
  }

  list(): readonly CaptionEntry[] {
    return this.entries;
  }

  getVersion = () => this.version;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }
}

/** Providers stream word pieces; keep spacing natural. */
export function joinText(prev: string, next: string): string {
  if (!prev) return next.trimStart();
  if (/^[\s,.;:!?…)\]]/.test(next) || /[\s(¿¡[]$/.test(prev)) return prev + next;
  return `${prev} ${next}`.replace(/\s{2,}/g, " ");
}
