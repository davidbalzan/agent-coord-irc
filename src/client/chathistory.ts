import { randomBytes } from "node:crypto";
import { formatLineWithTags, type IrcMessage } from "../protocol.js";
import { loadChannelHistory, loadInboxHistory } from "../history.js";
import type { Client } from "./index.js";

export const CHATHISTORY_MAX = 200;

type Entry = { id?: string; ts: number; from: string; text: string };

function chatHistoryError(
  c: Client,
  sub: string,
  target: string | undefined,
  msg: string,
): void {
  const params = target
    ? [c.nick!, "CHATHISTORY", sub, target, msg]
    : [c.nick!, "CHATHISTORY", sub, msg];
  c.send("400", params);
}

export async function handleChatHistory(c: Client, msg: IrcMessage): Promise<void> {
  if (!c.caps.has("draft/chathistory")) {
    c.sendNumeric("421", ["CHATHISTORY", "Unknown command"]);
    return;
  }
  const sub = (msg.params[0] ?? "").toUpperCase();
  if (!sub) {
    c.send("400", [c.nick!, "CHATHISTORY", "Subcommand required"]);
    return;
  }
  if (sub === "AROUND" || sub === "TARGETS") {
    chatHistoryError(c, sub, undefined, "Subcommand not implemented");
    return;
  }
  if (!["LATEST", "BEFORE", "AFTER", "BETWEEN"].includes(sub)) {
    chatHistoryError(c, sub, undefined, "Unknown subcommand");
    return;
  }
  const target = msg.params[1];
  if (!target) {
    c.sendNumeric("461", ["CHATHISTORY", sub, "Not enough parameters"]);
    return;
  }

  let entries: Entry[];
  if (target.startsWith("#")) {
    if (!c.joined.has(target)) {
      c.sendNumeric("442", [target, "You're not on that channel"]);
      return;
    }
    entries = await loadChannelHistory(target);
  } else {
    if (target.toLowerCase() !== c.nick!.toLowerCase()) {
      chatHistoryError(c, sub, target, "Cannot fetch other users' history");
      return;
    }
    entries = await loadInboxHistory(c.nick!);
  }

  const parseTs = (s: string): number | null => {
    if (!s.startsWith("timestamp=")) return null;
    const iso = s.slice("timestamp=".length);
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  };
  const parseLimit = (s: string): number | null => {
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (n < 1 || n > CHATHISTORY_MAX) return null;
    return n;
  };

  let result: Entry[] = [];
  if (sub === "LATEST") {
    const criterion = msg.params[2] ?? "*";
    const limit = parseLimit(msg.params[3] ?? "");
    if (limit === null) {
      chatHistoryError(c, sub, target, "Invalid limit");
      return;
    }
    if (criterion === "*") {
      result = entries.slice(-limit);
    } else {
      const ts = parseTs(criterion);
      if (ts === null) {
        chatHistoryError(c, sub, target, "Invalid timestamp format");
        return;
      }
      result = entries.filter((e) => e.ts > ts).slice(-limit);
    }
  } else if (sub === "BEFORE") {
    const ts = parseTs(msg.params[2] ?? "");
    const limit = parseLimit(msg.params[3] ?? "");
    if (ts === null) {
      chatHistoryError(c, sub, target, "Invalid timestamp format");
      return;
    }
    if (limit === null) {
      chatHistoryError(c, sub, target, "Invalid limit");
      return;
    }
    result = entries.filter((e) => e.ts < ts).slice(-limit);
  } else if (sub === "AFTER") {
    const ts = parseTs(msg.params[2] ?? "");
    const limit = parseLimit(msg.params[3] ?? "");
    if (ts === null) {
      chatHistoryError(c, sub, target, "Invalid timestamp format");
      return;
    }
    if (limit === null) {
      chatHistoryError(c, sub, target, "Invalid limit");
      return;
    }
    result = entries.filter((e) => e.ts > ts).slice(0, limit);
  } else if (sub === "BETWEEN") {
    const ts1 = parseTs(msg.params[2] ?? "");
    const ts2 = parseTs(msg.params[3] ?? "");
    const limit = parseLimit(msg.params[4] ?? "");
    if (ts1 === null || ts2 === null) {
      chatHistoryError(c, sub, target, "Invalid timestamp format");
      return;
    }
    if (limit === null) {
      chatHistoryError(c, sub, target, "Invalid limit");
      return;
    }
    const lo = Math.min(ts1, ts2);
    const hi = Math.max(ts1, ts2);
    result = entries.filter((e) => e.ts > lo && e.ts < hi).slice(0, limit);
  }

  emitChatHistory(c, target, result);
}

function emitChatHistory(c: Client, target: string, entries: Entry[]): void {
  const useBatch = c.caps.has("batch");
  const useTime = c.caps.has("server-time");
  const batchId = randomBytes(6).toString("hex");
  if (useBatch) {
    c.send("BATCH", [`+${batchId}`, "chathistory", target]);
  }
  for (const entry of entries) {
    const iso = new Date(entry.ts).toISOString();
    const prefix = `${entry.from}!${entry.from}@coord`;
    for (const line of entry.text.split("\n")) {
      if (line.length === 0) continue;
      const tags: Record<string, string> = {};
      if (useTime) tags["time"] = iso;
      if (useBatch) tags["batch"] = batchId;
      if (c.closed) return;
      c.socket.write(formatLineWithTags(tags, prefix, "PRIVMSG", [target, line]));
    }
  }
  if (useBatch) {
    c.send("BATCH", [`-${batchId}`]);
  }
}
