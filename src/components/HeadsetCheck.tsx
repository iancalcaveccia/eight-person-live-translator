"use client";

import { useEffect, useRef, useState } from "react";
import { isIOS, listDevices, looksLikeHeadset, playTestTone, recordLoopback } from "@/client/media/devices";
import { getSettings, updateSettings } from "@/client/prefs";
import { HeadsetIcon, MicIcon, SpeakerIcon } from "./icons";

/**
 * Pre-join headset check: microphone permission, which mic is actually used
 * (label heuristic), live level, test chime, and a local-only loopback.
 */
export default function HeadsetCheck() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(() => getSettings().micDeviceId);
  const [level, setLevel] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "asking" | "ready" | "denied" | "error">("idle");
  const [loopUrl, setLoopUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  async function start(id: string | null) {
    stop();
    setStatus("asking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id ? { exact: id } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      setLabel(track?.label ?? null);
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        setLevel(Math.min(1, Math.sqrt(s / buf.length) * 6));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setDevices(await listDevices("audioinput"));
      setStatus("ready");
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setStatus(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error");
    }
  }

  function stop() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
  }

  useEffect(() => {
    return () => {
      stop();
      void ctxRef.current?.close().catch(() => undefined);
    };
  }, []);

  async function choose(id: string) {
    setDeviceId(id);
    updateSettings({ micDeviceId: id });
    await start(id);
  }

  async function loopback() {
    setRecording(true);
    stop();
    try {
      if (loopUrl) URL.revokeObjectURL(loopUrl);
      const url = await recordLoopback(deviceId, 3);
      setLoopUrl(url);
      const a = new Audio(url);
      await a.play().catch(() => undefined);
    } finally {
      setRecording(false);
      await start(deviceId);
    }
  }

  const headset = looksLikeHeadset(label ?? undefined);

  return (
    <div className="stack">
      {status === "idle" && (
        <>
          <p className="small muted">
            Connect your Bluetooth headset first, then check that its microphone is the one being used.
            {isIOS() && " On iPhone, iOS picks the headset automatically when it is connected."}
          </p>
          <button type="button" className="btn btn-secondary btn-block" onClick={() => start(deviceId)}>
            <HeadsetIcon /> Check my headset
          </button>
        </>
      )}
      {status === "asking" && <p className="small muted">Allow microphone access when your browser asks…</p>}
      {status === "denied" && (
        <div className="notice notice-err">
          Microphone access is blocked. Allow it for this site in your browser settings, then try again.
        </div>
      )}
      {status === "error" && (
        <div className="notice notice-warn">That microphone could not be opened. Pick another one or reconnect your headset.</div>
      )}
      {status === "ready" && (
        <div className="stack">
          <div className="row-between">
            <div className="row" style={{ minWidth: 0 }}>
              <MicIcon width={18} height={18} />
              <span className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label || "Microphone"}
              </span>
            </div>
            <span className={`pill ${headset ? "pill-live" : "pill-warn"}`}>
              <span className="dot" />
              {headset ? "Headset" : "Phone mic?"}
            </span>
          </div>
          <div className="meter" aria-label="Microphone level">
            <div style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          {devices.length > 1 && (
            <select className="select" value={deviceId ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Microphone">
              <option value="">System default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Microphone"} {looksLikeHeadset(d.label) ? "🎧" : ""}
                </option>
              ))}
            </select>
          )}
          {!headset && (
            <p className="small faint">
              We can&apos;t confirm a headset microphone from its name. Record a test: if you sound distant or echoey,
              you are probably on the phone microphone.
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-secondary btn-sm grow"
              onClick={async () => {
                const ctx = ctxRef.current ?? new AudioContext();
                ctxRef.current = ctx;
                await playTestTone(ctx);
              }}
            >
              <SpeakerIcon width={18} height={18} /> Test sound
            </button>
            <button type="button" className="btn btn-secondary btn-sm grow" onClick={loopback} disabled={recording}>
              <MicIcon width={18} height={18} /> {recording ? "Recording 3 s…" : "Record & play"}
            </button>
          </div>
          <p className="small faint">The test recording stays on this phone and is discarded.</p>
        </div>
      )}
    </div>
  );
}
