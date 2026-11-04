"use client";

import type { GatheringStateView, MediaTokenView } from "@/lib/api-types";
import type { EsRegion, ListenLang, SpeakLang } from "@/lib/languages";

export class ClientApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new ClientApiError(0, "network", "No connection to the server. Retrying…");
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ClientApiError(res.status, body.error ?? "error", body.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export interface PublicConfig {
  hostCodeRequired: boolean;
  mediaConfigured: boolean;
  maxHumans: number;
  defaultProvider: string;
  perGatheringCapUsd: number;
}

export interface JoinPrefs {
  displayName: string;
  speakLang: SpeakLang;
  listenLang: ListenLang;
  esRegion: EsRegion;
  consent: true;
}

const g = (gid: string) => `/api/gatherings/${gid}`;

export const api = {
  config: () => request<PublicConfig>("/api/config"),
  createGathering: (body: JoinPrefs & { title: string; hostCode?: string }) =>
    post<{ gatheringId: string; participantId: string; inviteUrlPath: string }>("/api/gatherings", body),
  join: (gid: string, body: JoinPrefs & { inviteToken: string }) =>
    post<{ gatheringId: string; participantId: string }>(`${g(gid)}/join`, body),
  state: (gid: string) => request<GatheringStateView>(`${g(gid)}/state`),
  updateMe: (gid: string, patch: Partial<Omit<JoinPrefs, "consent">>) =>
    request<{ ok: true }>(`${g(gid)}/me`, { method: "PATCH", body: JSON.stringify(patch) }),
  token: (gid: string) => post<MediaTokenView>(`${g(gid)}/token`),
  enterGroup: (gid: string, groupId: string) => post<MediaTokenView>(`${g(gid)}/groups/${groupId}/enter`),
  returnToMain: (gid: string) => post<MediaTokenView>(`${g(gid)}/main`),
  leaveGroup: (gid: string, groupId: string) => post<MediaTokenView>(`${g(gid)}/groups/${groupId}/leave`),
  createGroup: (gid: string, name: string, inviteeIds: string[]) =>
    post<{ groupId: string; media: MediaTokenView }>(`${g(gid)}/groups`, { name, inviteeIds }),
  invite: (gid: string, groupId: string, participantIds: string[]) =>
    post<{ ok: true; sent: number }>(`${g(gid)}/groups/${groupId}/invite`, { participantIds }),
  respond: (gid: string, invId: string, action: "accept" | "decline") =>
    post<{ ok: true; media: MediaTokenView | null }>(`${g(gid)}/invitations/${invId}`, { action }),
  removeMember: (gid: string, groupId: string, pid: string) =>
    request<{ ok: true }>(`${g(gid)}/groups/${groupId}/members/${pid}`, { method: "DELETE" }),
  renameGroup: (gid: string, groupId: string, name: string) =>
    request<{ ok: true }>(`${g(gid)}/groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  kick: (gid: string, pid: string) => post<{ ok: true }>(`${g(gid)}/participants/${pid}/kick`),
  mute: (gid: string, pid: string) => post<{ ok: boolean }>(`${g(gid)}/participants/${pid}/mute`),
  rotateInvite: (gid: string) => post<{ inviteUrlPath: string }>(`${g(gid)}/invite/rotate`),
  end: (gid: string) => post<{ ok: true }>(`${g(gid)}/end`),
  leaveGathering: (gid: string) => post<{ ok: true }>(`${g(gid)}/leave`),
  usage: (gid: string) => request<UsageReport>(`${g(gid)}/usage`),
};

export interface UsageReport {
  budget: GatheringStateView["budget"];
  byLanguage: {
    provider: string;
    targetLang: string;
    inputMinutes: number;
    outputMinutes: number;
    costUsd: number;
    firstAudioP50Ms: number | null;
    firstAudioP95Ms: number | null;
    samples: number;
  }[];
}
