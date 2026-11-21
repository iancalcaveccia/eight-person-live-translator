"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/client/api";
import type { HomeView } from "@/lib/api-types";
import { BrandGlyph } from "@/components/BrandMark";
import TablesHome from "@/components/home/TablesHome";
import Welcome from "@/components/home/Welcome";

const POLL_MS = 10_000;

/**
 * Home. Remembered on this phone → your tables and people (who is at a table
 * right now refreshes every 10 s while the screen is visible). Otherwise the
 * welcome screen.
 */
export default function Home() {
  const [home, setHome] = useState<HomeView | null | undefined>(undefined);

  const load = useCallback(() => {
    api
      .home()
      .then(setHome)
      .catch(() => setHome((h) => (h === undefined ? null : h)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  if (home === undefined) {
    return (
      <main className="full-center">
        <div className="hero-mark">
          <BrandGlyph />
        </div>
      </main>
    );
  }
  if (!home?.person) return <Welcome onRemembered={load} />;
  return <TablesHome home={home} reload={load} />;
}
