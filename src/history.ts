import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { COORD_DIR } from "./registry.js";
import {
  channelBase,
  channelJsonlPath,
  inboxJsonlPath,
  type ChannelMessage,
} from "./channels.js";

const LEGACY_ROOM_FILE = path.join(COORD_DIR, "room.jsonl");

async function readJsonl(file: string): Promise<ChannelMessage[]> {
  if (!existsSync(file)) return [];
  try {
    const raw = await fs.readFile(file, "utf8");
    const out: ChannelMessage[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as ChannelMessage;
        if (typeof e.ts === "number" && typeof e.from === "string" && typeof e.text === "string") {
          out.push(e);
        }
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Load channel history. For #general specifically, merge with the legacy
 * pre-multi-channel room.jsonl (filtered to entries that look like #general).
 * Sorted ascending by ts.
 */
export async function loadChannelHistory(channel: string): Promise<ChannelMessage[]> {
  const base = channelBase(channel);
  const main = await readJsonl(channelJsonlPath(channel));
  if (base === "general") {
    const legacy = await readJsonl(LEGACY_ROOM_FILE);
    const eligible = legacy.filter(
      (e) => !e.room || e.room === "general" || e.room === "#general",
    );
    const merged = [...main, ...eligible];
    merged.sort((a, b) => a.ts - b.ts);
    return merged;
  }
  return main.sort((a, b) => a.ts - b.ts);
}

export async function loadInboxHistory(nick: string): Promise<ChannelMessage[]> {
  const entries = await readJsonl(inboxJsonlPath(nick));
  return entries.sort((a, b) => a.ts - b.ts);
}
