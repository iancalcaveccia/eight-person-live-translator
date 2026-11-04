"use client";

import { useEffect } from "react";

/** Registers the minimal service worker that makes the app installable. */
export default function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
