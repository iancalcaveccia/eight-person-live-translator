"use client";

import { useEffect, useRef, useState } from "react";

const HOLD_MS = 1500;

/**
 * Pocket mode: the page stays in front with the screen awake (so the phone
 * keeps the microphone running — browsers stop a web page's microphone a few
 * seconds after the screen turns off), but everything goes black and ignores
 * touches. Black pixels cost almost nothing on OLED screens. Unlock by holding
 * the ring for 1.5 s; the text drifts every minute so nothing burns in.
 */
export default function PocketMode({
  micOn,
  peopleCount,
  onExit,
}: {
  micOn: boolean;
  peopleCount: number;
  onExit: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const [shift, setShift] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitRef = useRef(onExit);
  useEffect(() => {
    exitRef.current = onExit;
  });

  useEffect(() => {
    const drift = setInterval(() => setShift((s) => (s + 1) % 5), 60_000);
    // An accidental "back" gesture leaves pocket mode instead of the gathering.
    history.pushState({ mesaPocket: true }, "");
    const onPop = () => exitRef.current();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && exitRef.current();
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(drift);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const start = () => {
    setHolding(true);
    timer.current = setTimeout(() => exitRef.current(), HOLD_MS);
  };
  const cancel = () => {
    setHolding(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <div className="pocket" role="dialog" aria-modal="true" aria-label="Pocket mode" onContextMenu={(e) => e.preventDefault()}>
      <div className="pocket-inner" style={{ transform: `translateY(${(shift - 2) * 36}px)` }}>
        <div className="pocket-status">
          <span className="pocket-dot" data-on={micOn} />
          {micOn ? "Mic on · Mesa keeps interpreting" : "Mic off · listening only"}
        </div>
        <div className="pocket-sub">
          {peopleCount === 0 ? "Nobody else here yet" : `${peopleCount + 1} people at the table`} · screen stays awake
        </div>
        <button
          className="pocket-unlock"
          data-holding={holding}
          aria-label="Hold to unlock"
          onPointerDown={start}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onPointerCancel={cancel}
        >
          <span className="pocket-ring" />
          <span>Hold to unlock</span>
        </button>
      </div>
    </div>
  );
}
