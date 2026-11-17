"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError } from "@/client/api";
import JoinFlow, { type JoinDetails } from "@/components/JoinFlow";
import { rememberName, useInviteToken } from "@/client/browser-values";
import type { HomeView, TablePreview } from "@/lib/api-types";

/** A saved table's link (`/t/<id>/join#k=…`): join once, then it lives on your home screen. */
export default function TableJoinPage({ params }: { params: Promise<{ tid: string }> }) {
  const { tid } = use(params);
  const router = useRouter();
  const inviteToken = useInviteToken();
  const [home, setHome] = useState<HomeView | null | undefined>(undefined);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .home()
      .then((h) => !cancelled && setHome(h))
      .catch(() => !cancelled && setHome(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    api
      .previewTable(tid, inviteToken)
      .then((p) => !cancelled && setPreview(p))
      .catch((err) => !cancelled && setLinkError(err instanceof ClientApiError ? err.message : "This link could not be opened"));
    return () => {
      cancelled = true;
    };
  }, [tid, inviteToken]);

  async function join(d: JoinDetails) {
    setBusy(true);
    setError(null);
    try {
      const res = home?.person
        ? await api.joinTable(tid, { inviteToken: inviteToken ?? "", consent: true })
        : await api.joinTable(tid, {
            inviteToken: inviteToken ?? "",
            displayName: d.displayName,
            ...d.langs,
            consent: true,
            remember: d.remember,
          });
      rememberName(d.displayName);
      router.replace(`/g/${res.gatheringId}`);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not join");
      setBusy(false);
    }
  }

  if (inviteToken !== null && !inviteToken) {
    return (
      <main className="full-center">
        <div className="container stack">
          <h1 className="display h-md">This link is incomplete</h1>
          <p className="muted">Ask someone at the table to share it again.</p>
        </div>
      </main>
    );
  }

  if (linkError) {
    return (
      <main className="full-center">
        <div className="container stack">
          <h1 className="display h-md">This link doesn&apos;t work</h1>
          <p className="muted">{linkError}</p>
          <button className="btn btn-secondary" onClick={() => router.push("/")}>
            Open Mesa
          </button>
        </div>
      </main>
    );
  }

  if (inviteToken === null || home === undefined || !preview) {
    return (
      <main className="full-center">
        <div className="spinner" />
      </main>
    );
  }

  const others = preview.memberNames.filter((n) => n !== home?.person?.displayName);
  const intro = (
    <>
      {preview.onlineNames.length > 0 ? (
        <p>
          <span className="live-dot" aria-hidden /> {preview.onlineNames.join(", ")} {preview.onlineNames.length === 1 ? "is" : "are"} talking
          now.
        </p>
      ) : others.length > 0 ? (
        <p>With {others.join(", ")}.</p>
      ) : null}
      <p>Everyone speaks their own language and hears the others interpreted live.</p>
    </>
  );

  return (
    <JoinFlow
      heading={`Join “${preview.name}”`}
      intro={intro}
      person={home?.person ?? null}
      onJoin={join}
      error={error}
      busy={busy}
    />
  );
}
