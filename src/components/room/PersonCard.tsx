"use client";

import type { RemoteHuman } from "@/client/media/session";
import type { HearingMode } from "@/client/media/routing";
import { flagFor, languageInfo } from "@/lib/languages";
import { FocusIcon, MicOffIcon, SpeakerOffIcon } from "../icons";
import { initials, speakerColor } from "./Sheet";

export default function PersonCard({
  person,
  hearing,
  level,
  active,
  focused,
  mutedLocally,
  onOpen,
}: {
  person: RemoteHuman;
  hearing: HearingMode;
  level: number;
  active: boolean;
  focused: boolean;
  mutedLocally: boolean;
  onOpen: () => void;
}) {
  const color = speakerColor(person.color);
  const lvl = active ? Math.min(1, 0.35 + level * 8) : 0;
  return (
    <button
      className="person"
      style={{ ["--pc" as string]: color }}
      data-active={active}
      data-muted-local={mutedLocally}
      onClick={onOpen}
      aria-label={`${person.name}, ${hearing === "translation" ? "translated" : "original voice"}${active ? ", speaking" : ""}`}
    >
      <div className="person-flags">
        {focused && <FocusIcon />}
        {mutedLocally && <SpeakerOffIcon />}
        {person.micMuted && <MicOffIcon />}
      </div>
      <div className="avatar" style={{ ["--level" as string]: lvl }}>
        {initials(person.name)}
      </div>
      <div className="person-name">{person.name}</div>
      <div className="person-meta">
        <span title={person.speakLang === "auto" ? "Switches languages" : languageInfo(person.speakLang)?.name}>
          {flagFor(person.speakLang, person.esRegion)} speaks
        </span>
        {hearing === "translation" && <span className="tag tag-tx">translated</span>}
        {hearing === "native" && <span className="tag">original</span>}
        {hearing === "none" && <span className="tag">in the room</span>}
      </div>
    </button>
  );
}
