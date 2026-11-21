import type { EsRegion, ListenLang, SpeakLang } from "./languages";

export interface MeView {
  id: string;
  displayName: string;
  speakLang: SpeakLang;
  listenLang: ListenLang;
  esRegion: EsRegion;
  role: "host" | "guest";
  color: number;
  activeGroupId: string | null;
  epoch: number;
}

export type ParticipantLocation =
  | { type: "group"; groupId: string; groupName: string; kind: "main" | "private" }
  | { type: "private" } // in a private group the viewer is not part of — no name, no members
  | { type: "none" };

export interface ParticipantView {
  id: string;
  displayName: string;
  color: number;
  speakLang: SpeakLang;
  listenLang: ListenLang;
  esRegion: EsRegion;
  role: "host" | "guest";
  online: boolean;
  location: ParticipantLocation;
}

export interface GroupView {
  id: string;
  kind: "main" | "private";
  name: string;
  isMember: boolean;
  isOwner: boolean;
  /** Members visible only to members (empty for main: everyone may enter). */
  members: { id: string; displayName: string; role: "owner" | "member" }[];
  /** People currently in this group's audio. */
  activeIds: string[];
}

export interface InvitationView {
  id: string;
  groupId: string;
  groupName: string;
  fromId: string;
  fromName: string;
  memberNames: string[];
  createdAt: string;
}

export interface BudgetView {
  gatheringUsd: number;
  gatheringCapUsd: number;
  dayUsd: number;
  dayCapUsd: number | null;
  monthUsd: number;
  monthCapUsd: number;
  translationAllowed: boolean;
  reason: string | null;
  warning: boolean;
}

export interface GatheringStateView {
  version: number;
  serverTime: string;
  gathering: {
    id: string;
    title: string;
    createdAt: string;
    expiresAt: string;
    hostId: string | null;
    maxHumans: number;
    inviteUrlPath: string;
  };
  me: MeView;
  participants: ParticipantView[];
  groups: GroupView[];
  invitations: InvitationView[];
  outgoingInvitations: { id: string; groupId: string; toId: string; toName: string }[];
  budget: BudgetView;
  /** Set when this gathering is the live session of a saved table. */
  table: { id: string; name: string; inviteUrlPath: string; isMember: boolean; isOwner: boolean } | null;
}

// ------------------------------------------------- remembered people & tables

export interface PersonView {
  id: string;
  displayName: string;
  speakLang: SpeakLang;
  listenLang: ListenLang;
  esRegion: EsRegion;
  /** False when the AI-consent text changed since they agreed: ask again before audio flows. */
  consentCurrent: boolean;
}

export interface TableMemberView {
  id: string;
  displayName: string;
  speakLang: SpeakLang;
  role: "owner" | "member";
  isMe: boolean;
}

export interface TableView {
  id: string;
  name: string;
  role: "owner" | "member";
  members: TableMemberView[];
  /** Members may re-share the table's link. */
  inviteUrlPath: string;
  /** The table's gathering right now, if one is running. */
  live: { gatheringId: string; onlineNames: string[]; meIn: boolean } | null;
}

export interface ContactView {
  id: string;
  displayName: string;
  speakLang: SpeakLang;
  listenLang: ListenLang;
  tableNames: string[];
}

export interface HomeView {
  person: PersonView | null;
  tables: TableView[];
  people: ContactView[];
}

export interface TablePreview {
  name: string;
  memberNames: string[];
  onlineNames: string[];
}

export interface MediaTokenView {
  token: string;
  serverUrl: string;
  room: string;
  groupId: string;
  epoch: number;
  expiresInSeconds: number;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}
