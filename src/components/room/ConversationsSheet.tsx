"use client";

import { useState } from "react";
import type { GatheringStateView } from "@/lib/api-types";
import { LockIcon, PlusIcon } from "../icons";
import Sheet, { initials, speakerColor } from "./Sheet";

export interface ConversationActions {
  enter: (groupId: string) => Promise<void>;
  returnToMain: () => Promise<void>;
  create: (name: string, inviteeIds: string[]) => Promise<void>;
  invite: (groupId: string, ids: string[]) => Promise<void>;
  respond: (invitationId: string, action: "accept" | "decline") => Promise<void>;
  leave: (groupId: string) => Promise<void>;
  remove: (groupId: string, participantId: string) => Promise<void>;
}

export default function ConversationsSheet({
  state,
  busy,
  actions,
  onClose,
}: {
  state: GatheringStateView;
  busy: boolean;
  actions: ConversationActions;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"list" | "create" | { inviteTo: string }>("list");
  const me = state.me;
  const current = state.groups.find((g) => g.id === me.activeGroupId);
  const others = state.participants.filter((p) => p.id !== me.id);
  const nameOf = new Map(state.participants.map((p) => [p.id, p.displayName]));

  if (mode === "create" || typeof mode === "object") {
    const groupId = typeof mode === "object" ? mode.inviteTo : null;
    const group = groupId ? state.groups.find((g) => g.id === groupId) : null;
    const candidates = others.filter((p) => !group?.members.some((m) => m.id === p.id));
    return (
      <PeoplePicker
        title={group ? `Invite to ${group.name}` : "New private conversation"}
        withName={!group}
        candidates={candidates.map((p) => ({ id: p.id, name: p.displayName, color: p.color, online: p.online }))}
        busy={busy}
        onBack={() => setMode("list")}
        onClose={onClose}
        onSubmit={async (name, ids) => {
          if (group) await actions.invite(group.id, ids);
          else await actions.create(name, ids);
          setMode("list");
          if (!group) onClose();
        }}
      />
    );
  }

  return (
    <Sheet title="Conversations" onClose={onClose}>
      {state.invitations.length > 0 && (
        <div className="sheet-section">
          <span className="section-label">Invitations</span>
          {state.invitations.map((inv) => (
            <div key={inv.id} className="card card-tight stack" style={{ borderColor: "var(--accent)" }}>
              <div>
                <strong>{inv.fromName}</strong> invited you to <strong>{inv.groupName}</strong>
                <div className="small faint">With {inv.memberNames.join(", ") || inv.fromName}</div>
              </div>
              <div className="row">
                <button className="btn btn-secondary btn-sm grow" disabled={busy} onClick={() => actions.respond(inv.id, "decline")}>
                  Not now
                </button>
                <button className="btn btn-primary btn-sm grow" disabled={busy} onClick={() => actions.respond(inv.id, "accept")}>
                  Join
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sheet-section">
        <span className="section-label">You are in</span>
        {current && (
          <div className="card card-tight stack">
            <div className="row-between">
              <div className="row">
                {current.kind === "private" && <LockIcon width={16} height={16} />}
                <strong>{current.name}</strong>
              </div>
              <span className="small faint">{current.activeIds.length} here</span>
            </div>
            <div className="small muted">
              You are speaking only with:{" "}
              {current.activeIds.filter((id) => id !== me.id).map((id) => nameOf.get(id) ?? "…").join(", ") || "nobody yet"}
            </div>
            {current.kind === "private" && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setMode({ inviteTo: current.id })}>
                  Invite someone
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => actions.leave(current.id)}>
                  Leave & return to main
                </button>
              </div>
            )}
            {current.kind === "private" && current.isOwner && current.members.length > 1 && (
              <details>
                <summary className="small faint">Manage members</summary>
                <div className="stack" style={{ marginTop: 8 }}>
                  {current.members
                    .filter((m) => m.id !== me.id)
                    .map((m) => (
                      <div key={m.id} className="row-between">
                        <span>{m.displayName}</span>
                        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => actions.remove(current.id, m.id)}>
                          Remove
                        </button>
                      </div>
                    ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="sheet-section">
        <span className="section-label">Switch to</span>
        {state.groups
          .filter((g) => g.id !== me.activeGroupId)
          .map((g) => (
            <button
              key={g.id}
              className="list-item"
              disabled={busy}
              onClick={() => (g.kind === "main" ? actions.returnToMain() : actions.enter(g.id))}
            >
              <div className="grow">
                <div className="row">
                  {g.kind === "private" && <LockIcon width={14} height={14} />}
                  <strong>{g.name}</strong>
                </div>
                <div className="small faint">
                  {g.activeIds.length} here
                  {g.activeIds.length > 0 && ` · ${g.activeIds.map((id) => nameOf.get(id) ?? "…").join(", ")}`}
                </div>
              </div>
              <span className="small" style={{ color: "var(--accent)", fontWeight: 600 }}>
                {g.kind === "main" ? "Return" : "Join"}
              </span>
            </button>
          ))}
        <button className="list-item" disabled={busy || others.length === 0} onClick={() => setMode("create")}>
          <span className="feature-icon">
            <PlusIcon />
          </span>
          <div className="grow">
            <strong>Start a private conversation</strong>
            <div className="small faint">Only people you invite can hear it or see its captions.</div>
          </div>
        </button>
      </div>

      <div className="sheet-section">
        <span className="section-label">Everyone at this gathering</span>
        {state.participants.map((p) => (
          <div key={p.id} className="row" style={{ minHeight: 44 }}>
            <span className="dot-avatar" style={{ ["--pc" as string]: speakerColor(p.color) }}>
              {initials(p.displayName)}
            </span>
            <div className="grow">
              <div>
                {p.displayName}
                {p.id === me.id && <span className="faint"> (you)</span>}
              </div>
              <div className="small faint">
                {!p.online
                  ? "Offline"
                  : p.location.type === "group"
                    ? p.location.groupName
                    : p.location.type === "private"
                      ? "In a private conversation"
                      : "Not connected"}
              </div>
            </div>
          </div>
        ))}
        <p className="small faint">
          Server-enforced: people outside a private conversation cannot receive its audio or captions. Microphones can
          still pick up voices that are physically nearby.
        </p>
      </div>
    </Sheet>
  );
}

function PeoplePicker({
  title,
  withName,
  candidates,
  busy,
  onBack,
  onClose,
  onSubmit,
}: {
  title: string;
  withName: boolean;
  candidates: { id: string; name: string; color: number; online: boolean }[];
  busy: boolean;
  onBack: () => void;
  onClose: () => void;
  onSubmit: (name: string, ids: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          await onSubmit(name.trim() || "Private chat", [...picked]);
        }}
      >
        {withName && (
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Outside" maxLength={40} autoFocus />
          </label>
        )}
        <span className="section-label">Invite</span>
        {candidates.length === 0 && <p className="small faint">Everyone is already here.</p>}
        {candidates.map((c) => (
          <label key={c.id} className="list-item" aria-current={picked.has(c.id)}>
            <span className="dot-avatar" style={{ ["--pc" as string]: speakerColor(c.color) }}>
              {initials(c.name)}
            </span>
            <span className="grow">
              {c.name}
              {!c.online && <span className="small faint"> · offline</span>}
            </span>
            <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 22, height: 22, accentColor: "var(--accent)" }} />
          </label>
        ))}
        <p className="small faint">
          {withName
            ? "You move into the new conversation right away. Invited people join when they accept."
            : "They'll get an invitation they can accept or decline."}
        </p>
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
          <button className="btn btn-primary grow" disabled={busy || (!withName && picked.size === 0)}>
            {busy ? <span className="spinner" /> : withName ? "Start conversation" : "Send invitation"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
