import { config } from "@/server/env";
import { hostCodeRequired } from "@/server/gatherings";
import { getMediaAdmin } from "@/server/livekit";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";

/** Public, non-secret configuration the UI needs before joining. */
export const GET = handle(async () =>
  json({
    hostCodeRequired: hostCodeRequired(),
    mediaConfigured: getMediaAdmin().configured,
    maxHumans: config.maxHumans,
    defaultProvider: config.defaultProvider,
    perGatheringCapUsd: config.maxSpendPerGatheringUsd,
  }),
);
