"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError } from "@/client/api";
import JoinFlow, { type JoinDetails } from "@/components/JoinFlow";
import { rememberName, useInviteToken } from "@/client/browser-values";
import type { HomeView } from "@/lib/api-types";

/** One-off gathering link (`/g/<id>/join#k=…`). */
export default function JoinPage({ params }: { params: Promise<{ gid: string }> }) {
  const { gid } = use(params);
  const router = useRouter();
  const inviteToken = useInviteToken();
  const [home, setHome] = useState<HomeView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already joined on this device? Go straight back in.
  useEffect(() => {
    let cancelled = false;
    api
      .state(gid)
      .then(() => !cancelled && router.replace(`/g/${gid}`))
      .catch(() => undefined);
    api
      .home()
      .then((h) => !cancelled && setHome(h))
      .catch(() => !cancelled && setHome(null));
    return () => {
      cancelled = true;
    };
  }, [gid, router]);

  async function join(d: JoinDetails) {
    setBusy(true);
    setError(null);
    try {
      const person = home?.person ?? null;
      if (!person && d.remember) await api.rememberMe({ displayName: d.displayName, ...d.langs, consent: true });
      if (person && !person.consentCurrent) await api.editProfile({ consent: true });
      await api.join(gid, { inviteToken: inviteToken ?? "", displayName: d.displayName, ...d.langs, consent: true });
      rememberName(d.displayName);
      router.replace(`/g/${gid}`);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not join");
      setBusy(false);
    }
  }

  if (inviteToken === null || home === undefined) {
    return (
      <main className="full-center">
        <div className="spinner" />
      </main>
    );
  }

  if (!inviteToken) {
    return (
      <main className="full-center">
        <div className="container stack">
          <h1 className="display h-md">This link is incomplete</h1>
          <p className="muted">Ask the host to share the invite link again, or scan their QR code.</p>
        </div>
      </main>
    );
  }

  return (
    <JoinFlow
      heading="You're invited"
      intro={home?.person ? "Join with your saved name and languages." : "Tell the table who you are and which languages you use."}
      person={home?.person ?? null}
      onJoin={join}
      error={error}
      busy={busy}
    />
  );
}
