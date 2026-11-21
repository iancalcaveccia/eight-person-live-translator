"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ClientApiError } from "@/client/api";
import type { HomeView, TableView } from "@/lib/api-types";
import { flagFor, speakLabel } from "@/lib/languages";
import { BrandGlyph } from "../BrandMark";
import ConsentBox from "../ConsentBox";
import InstallCard from "../InstallCard";
import { PlusIcon, UserIcon } from "../icons";
import Sheet from "../room/Sheet";
import { colorFor } from "./colors";
import NewTableSheet from "./NewTableSheet";
import PasteLink from "./PasteLink";
import ProfileSheet from "./ProfileSheet";
import TableSheet from "./TableSheet";

type SheetName = null | "profile" | "new" | { table: string };

/** Home for someone remembered on this phone: their tables and people. */
export default function TablesHome({ home, reload }: { home: HomeView; reload: () => void }) {
  const router = useRouter();
  const person = home.person!;
  const [sheet, setSheet] = useState<SheetName>(null);
  const [busyTable, setBusyTable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  async function enter(tid: string) {
    setBusyTable(tid);
    setError(null);
    try {
      const r = await api.enterTable(tid);
      router.push(`/g/${r.gatheringId}`);
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "consent_required") setConsentFor(tid);
      else setError(err instanceof ClientApiError ? err.message : "Could not open the table");
      setBusyTable(null);
    }
  }

  const managed = typeof sheet === "object" && sheet !== null ? home.tables.find((t) => t.id === sheet.table) : undefined;

  return (
    <main className="page home">
      <div className="container stack-lg">
        <header className="home-head">
          <div className="hero-mark hero-mark-sm">
            <BrandGlyph size={22} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small faint">Mesa</div>
            <h1 className="display h-md home-hello">Hi, {person.displayName}</h1>
          </div>
          <button className="icon-btn" aria-label="My name and languages" onClick={() => setSheet("profile")}>
            <UserIcon />
          </button>
        </header>

        <InstallCard />

        <section className="stack" aria-label="Your tables">
          <span className="section-label">Your tables</span>
          {home.tables.length === 0 && (
            <div className="empty">
              <p>No tables yet. Start one and send its link once — after that, everyone just taps it here.</p>
            </div>
          )}
          {home.tables.map((t) => (
            <TableCard key={t.id} table={t} busy={busyTable === t.id} onEnter={() => void enter(t.id)} onManage={() => setSheet({ table: t.id })} />
          ))}
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary btn-block" onClick={() => setSheet("new")}>
            <PlusIcon width={18} height={18} /> New table
          </button>
        </section>

        {home.people.length > 0 && (
          <section className="stack" aria-label="Your people">
            <span className="section-label">Your people</span>
            <ul className="people-list">
              {home.people.map((p) => (
                <li key={p.id} className="contact">
                  <span className="dot-avatar" style={{ ["--pc" as string]: colorFor(p.id) }}>
                    {p.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="contact-name">{p.displayName}</span>
                    <span className="small muted contact-sub">
                      {flagFor(p.speakLang)} {speakLabel(p.speakLang)} · {p.tableNames.join(", ")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="small faint">People appear here once you share a table. To start a new table with some of them, tap “New table”.</p>
          </section>
        )}

        <PasteLink />

        <p className="small faint" style={{ textAlign: "center" }}>
          Only your name and languages are saved. <Link href="/privacy">Privacy</Link>
        </p>
      </div>

      {sheet === "profile" && <ProfileSheet person={person} onClose={() => setSheet(null)} onChanged={reload} />}
      {sheet === "new" && (
        <NewTableSheet people={home.people} onClose={() => setSheet(null)} onCreated={(gid) => router.push(`/g/${gid}?invite=1`)} />
      )}
      {managed && <TableSheet table={managed} me={person} onClose={() => setSheet(null)} onChanged={reload} />}
      {consentFor && (
        <Sheet title="Before you talk" onClose={() => setConsentFor(null)}>
          <div className="stack">
            <ConsentBox checked={consent} onChange={setConsent} />
            <button
              className="btn btn-primary btn-block"
              disabled={!consent}
              onClick={async () => {
                const tid = consentFor;
                await api.editProfile({ consent: true }).catch(() => undefined);
                setConsentFor(null);
                void enter(tid);
              }}
            >
              Agree and sit down
            </button>
          </div>
        </Sheet>
      )}
    </main>
  );
}

function TableCard({ table, busy, onEnter, onManage }: { table: TableView; busy: boolean; onEnter: () => void; onManage: () => void }) {
  const others = table.members.filter((m) => !m.isMe);
  const online = table.live?.onlineNames ?? [];
  const live = online.length > 0;
  let line: React.ReactNode;
  if (live) {
    line = (
      <>
        <span className="live-dot" aria-hidden /> {online.join(", ")} {online.length === 1 ? "is" : "are"} here now
      </>
    );
  } else if (others.length > 0) {
    line = `With ${others.map((m) => m.displayName).join(", ")}`;
  } else {
    line = "Just you so far — share its link";
  }
  return (
    <div className="table-card" data-live={live}>
      <button className="table-main" onClick={onEnter} disabled={busy} aria-label={`${live ? "Join" : "Open"} ${table.name}`}>
        <span className="table-avatars" aria-hidden>
          {(others.length > 0 ? others : table.members).slice(0, 3).map((m) => (
            <span key={m.id} className="mini-avatar" style={{ ["--pc" as string]: colorFor(m.id) }}>
              {m.displayName.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
        <span className="grow table-text">
          <span className="table-name">{table.name}</span>
          <span className="small muted table-line">{line}</span>
        </span>
        <span className={`table-go ${live ? "table-go-live" : ""}`}>{busy ? <span className="spinner" /> : live ? "Join" : "Start"}</span>
      </button>
      <button className="icon-btn icon-btn-sm table-more" aria-label={`Manage ${table.name}`} onClick={onManage}>
        <span aria-hidden>⋯</span>
      </button>
    </div>
  );
}
