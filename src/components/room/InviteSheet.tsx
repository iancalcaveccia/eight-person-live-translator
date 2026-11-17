"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShareIcon } from "../icons";
import Sheet from "./Sheet";

export default function InviteSheet({
  inviteUrlPath,
  tableName,
  canRotate,
  seatsLeft,
  onRotate,
  onClose,
}: {
  inviteUrlPath: string;
  /** Set for a saved table: the link stays valid for next time too. */
  tableName: string | null;
  canRotate: boolean;
  seatsLeft: number;
  onRotate: () => Promise<void>;
  onClose: () => void;
}) {
  const url = typeof window === "undefined" ? inviteUrlPath : `${window.location.origin}${inviteUrlPath}`;
  const [svg, setSvg] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#120c08", light: "#ffffff" } })
      .then((s) => !cancelled && setSvg(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function share() {
    const data = {
      title: tableName ? `Join “${tableName}” on Mesa` : "Join our table on Mesa",
      text: "Live interpretation: everyone speaks their own language",
      url,
    };
    if (navigator.share) {
      await navigator.share(data).catch(() => undefined);
    } else {
      await copy();
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <Sheet title="Invite people" onClose={onClose}>
      <div className="stack">
        <p className="muted small">
          Scan with the phone camera, or share the link. {seatsLeft > 0 ? `${seatsLeft} seat${seatsLeft === 1 ? "" : "s"} left.` : "The gathering is full."}
        </p>
        <div className="qr" aria-label="Invite QR code" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="link-box">{url}</div>
        <div className="row">
          <button className="btn btn-primary grow" onClick={share}>
            <ShareIcon width={18} height={18} /> Share
          </button>
          <button className="btn btn-secondary grow" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="small faint">
          {tableName
            ? "Send it once: whoever opens it is saved at this table and next time just taps it on Mesa's home screen. Treat it like a key."
            : "Anyone with this link can join until the gathering is full. Treat it like a key."}
        </p>
        {canRotate && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={rotating}
            onClick={async () => {
              setRotating(true);
              try {
                await onRotate();
              } finally {
                setRotating(false);
              }
            }}
          >
            {rotating
              ? "Making a new link…"
              : tableName
                ? "Replace link (old link stops working; saved people keep their place)"
                : "Replace link (old link and QR stop working)"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
