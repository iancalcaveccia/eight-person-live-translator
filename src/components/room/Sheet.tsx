"use client";

import { useEffect, useRef } from "react";
import { CloseIcon } from "../icons";

export default function Sheet({
  title,
  onClose,
  children,
  label,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} ref={ref} tabIndex={-1}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

export function speakerColor(color: number | undefined): string {
  return `var(--c${((color ?? 0) % 8 + 8) % 8})`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}
