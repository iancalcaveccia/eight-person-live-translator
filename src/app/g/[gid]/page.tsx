"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import RoomScreen from "@/components/room/RoomScreen";

export default function GatheringPage({ params }: { params: Promise<{ gid: string }> }) {
  const { gid } = use(params);
  const search = useSearchParams();
  return <RoomScreen gid={gid} openInvite={search.get("invite") === "1"} />;
}
