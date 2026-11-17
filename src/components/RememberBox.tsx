"use client";

/** "Remember me on this phone" — on by default; off means a one-time visit that leaves nothing saved. */
export default function RememberBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check remember-box">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Remember me on this phone</strong>
        <span className="small muted remember-sub">
          Next time, open Mesa and tap your table — no forms, no new link. Saves only your name and languages. You can
          forget it any time.
        </span>
      </span>
    </label>
  );
}
