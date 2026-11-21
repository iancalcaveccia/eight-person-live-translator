"use client";

import Link from "next/link";

export default function ConsentBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="card card-tight stack">
      <p className="small muted">
        <strong style={{ color: "var(--fg)" }}>Live AI interpretation.</strong> While your microphone is on, your
        voice is streamed to LiveKit (audio delivery) and to Google Gemini — or OpenAI as a backup — to translate it
        in real time. Mesa does not record audio or store transcripts. Private conversations are private from other
        guests, not from these providers. Your microphone can also pick up people sitting near you.{" "}
        <Link href="/privacy" target="_blank" style={{ color: "var(--accent)" }}>
          Details
        </Link>
      </p>
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>I am an adult and I agree to my speech being processed live by these AI services.</span>
      </label>
    </div>
  );
}
