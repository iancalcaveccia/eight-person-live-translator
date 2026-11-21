import "server-only";
import {
  AccessToken,
  DataPacket_Kind,
  RoomAgentDispatch,
  RoomConfiguration,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from "livekit-server-sdk";
import { config, TRANSLATOR_AGENT_NAME } from "./env";
import { ApiError } from "./http";

export interface MintTokenInput {
  room: string;
  identity: string;
  name: string;
  attributes: Record<string, string>;
  dispatchMetadata: Record<string, unknown>;
  ttlSeconds: number;
}

/** Everything the control plane does to LiveKit. Swappable for tests. */
export interface MediaAdmin {
  readonly configured: boolean;
  readonly serverUrl: string;
  mintToken(input: MintTokenInput): Promise<string>;
  removeParticipant(room: string, identity: string): Promise<void>;
  updateAttributes(room: string, identity: string, attributes: Record<string, string>): Promise<void>;
  sendData(room: string, identities: string[], payload: unknown, topic: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  muteMicrophone(room: string, identity: string): Promise<boolean>;
}

/** 8 humans + agent + 1 slack for a reconnect overlap. Humans are capped by the DB. */
export const ROOM_MAX_PARTICIPANTS = 10;
export const ROOM_EMPTY_TIMEOUT = 60;
export const ROOM_DEPARTURE_TIMEOUT = 20;

export function buildAccessToken(apiKey: string, apiSecret: string, input: MintTokenInput): AccessToken {
  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: input.ttlSeconds,
    attributes: input.attributes,
  });
  at.addGrant({
    roomJoin: true,
    room: input.room,
    canSubscribe: true,
    canPublish: true,
    // Microphone only: no camera/screen share in an audio interpreter.
    canPublishSources: [TrackSource.MICROPHONE],
    // Clients must not be able to forge captions or worker events.
    canPublishData: false,
    // Attributes (languages, epoch) are server-authoritative.
    canUpdateOwnMetadata: false,
  });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: TRANSLATOR_AGENT_NAME,
        metadata: JSON.stringify(input.dispatchMetadata),
      }),
    ],
    emptyTimeout: ROOM_EMPTY_TIMEOUT,
    departureTimeout: ROOM_DEPARTURE_TIMEOUT,
    maxParticipants: ROOM_MAX_PARTICIPANTS,
  });
  return at;
}

function httpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  return e?.status === 404 || e?.code === "not_found" || /not.?found|does not exist/i.test(e?.message ?? "");
}

class LiveKitAdmin implements MediaAdmin {
  readonly configured = true;
  private client: RoomServiceClient;

  constructor(
    readonly serverUrl: string,
    private apiKey: string,
    private apiSecret: string,
  ) {
    this.client = new RoomServiceClient(httpUrl(serverUrl), apiKey, apiSecret);
  }

  async mintToken(input: MintTokenInput): Promise<string> {
    return buildAccessToken(this.apiKey, this.apiSecret, input).toJwt();
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    try {
      await this.client.removeParticipant(room, identity);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async updateAttributes(room: string, identity: string, attributes: Record<string, string>): Promise<void> {
    try {
      await this.client.updateParticipant(room, identity, { attributes });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async sendData(room: string, identities: string[], payload: unknown, topic: string): Promise<void> {
    if (identities.length === 0) return;
    try {
      await this.client.sendData(room, new TextEncoder().encode(JSON.stringify(payload)), DataPacket_Kind.RELIABLE, {
        destinationIdentities: identities,
        topic,
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deleteRoom(room: string): Promise<void> {
    try {
      await this.client.deleteRoom(room);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async muteMicrophone(room: string, identity: string): Promise<boolean> {
    try {
      const p = await this.client.getParticipant(room, identity);
      const mic = p.tracks.find((t) => t.type === TrackType.AUDIO && t.source === TrackSource.MICROPHONE);
      if (!mic) return false;
      await this.client.mutePublishedTrack(room, identity, mic.sid, true);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

/** Used when LiveKit credentials are absent (UI still loads; media is unavailable). */
class UnconfiguredAdmin implements MediaAdmin {
  readonly configured = false;
  readonly serverUrl = "";
  async mintToken(): Promise<string> {
    throw new ApiError(503, "media_not_configured", "LiveKit is not configured on this server");
  }
  async removeParticipant() {}
  async updateAttributes() {}
  async sendData() {}
  async deleteRoom() {}
  async muteMicrophone() {
    return false;
  }
}

declare global {
  var __interpMediaAdmin: MediaAdmin | undefined;
}

export function getMediaAdmin(): MediaAdmin {
  if (globalThis.__interpMediaAdmin) return globalThis.__interpMediaAdmin;
  const { livekitUrl, livekitApiKey, livekitApiSecret } = config;
  const admin =
    livekitUrl && livekitApiKey && livekitApiSecret
      ? new LiveKitAdmin(livekitUrl, livekitApiKey, livekitApiSecret)
      : new UnconfiguredAdmin();
  globalThis.__interpMediaAdmin = admin;
  return admin;
}

/** Tests only. */
export function setMediaAdminForTests(admin: MediaAdmin | undefined): void {
  globalThis.__interpMediaAdmin = admin;
}

/** Fire-and-forget wrapper: media side effects must never break a committed DB change. */
export async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[livekit] ${label} failed:`, err instanceof Error ? err.message : "unknown");
  }
}
