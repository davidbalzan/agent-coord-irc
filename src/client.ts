import type { Socket } from "node:net";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { formatLine, formatLineWithTags, type IrcMessage } from "./protocol.js";
import { loadChannelHistory, loadInboxHistory } from "./history.js";
import {
  upsertAgent,
  removeAgent,
  bumpHeartbeat,
  listAgentIds,
  readServerPass,
} from "./registry.js";
import {
  addMember,
  appendChannelMessage,
  appendInboxMessage,
  channelBase,
  ensureChannel,
  isValidChannelName,
  listChannels,
  readChannel,
  removeMember,
  setTopic,
} from "./channels.js";
import type { Hub } from "./hub.js";

export type ClientState = "PENDING" | "CAP_NEGOTIATING" | "REGISTERED";

const NICK_RE = /^[A-Za-z][A-Za-z0-9._\-]{0,31}$/;
const HEARTBEAT_MS = 30_000;
const PING_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 30_000;
const DEFAULT_CHANNEL = "#general";

const SUPPORTED_CAPS = [
  "message-tags",
  "server-time",
  "batch",
  "draft/chathistory",
];

const CHATHISTORY_MAX = 200;

export interface ServerContext {
  hostname: string;
  version: string;
  startedAtIso: string;
  clientsByNick: Map<string, Client>; // lowercase nick → client
  hub: Hub;
}

export class Client {
  state: ClientState = "PENDING";
  nick: string | null = null;
  user: string | null = null;
  realname: string | null = null;
  passSubmitted: string | null = null;
  capNegotiating = false;
  capsRequested: string[] = [];
  caps: Set<string> = new Set();
  buf = "";
  closed = false;
  // Channel name (incl. "#") → last known topicVersion seen by this client.
  joined: Map<string, number> = new Map();

  private lastPongTs = Date.now();
  private pingToken: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingDeadlineTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(public socket: Socket, public ctx: ServerContext) {}

  send(command: string, params: string[], prefix?: string): void {
    if (this.closed) return;
    this.socket.write(formatLine(prefix ?? this.ctx.hostname, command, params));
  }

  /** Send with an explicit prefix (e.g. another user's nick!user@host). */
  sendRaw(prefix: string, command: string, params: string[]): void {
    if (this.closed) return;
    this.socket.write(formatLine(prefix, command, params));
  }

  sendNumeric(code: string, params: string[]): void {
    const target = this.nick ?? "*";
    this.send(code, [target, ...params]);
  }

  /** "nick!user@host" prefix for messages originating from this client. */
  userPrefix(): string {
    const n = this.nick ?? "*";
    const u = this.user ?? n;
    return `${n}!${u}@coord`;
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (reason) {
      try {
        this.socket.write(formatLine(undefined, "ERROR", [reason]));
      } catch {
        /* ignore */
      }
    }
    this.stopTimers();
    let nickToRemove: string | null = null;
    if (this.state === "REGISTERED" && this.nick) {
      this.ctx.clientsByNick.delete(this.nick.toLowerCase());
      nickToRemove = this.nick;
      // Detach from all channels and inbox poller.
      for (const channel of this.joined.keys()) {
        this.ctx.hub.removeChannelClient(channel, this);
        // Also drop membership from sidecar so list_agents / NAMES reflect it.
        try {
          await removeMember(channel, this.nick);
        } catch {
          /* ignore */
        }
      }
      this.joined.clear();
      this.ctx.hub.removeInboxClient(this.nick);
    }
    if (nickToRemove) {
      try {
        await removeAgent(nickToRemove);
      } catch {
        /* ignore */
      }
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pingDeadlineTimer) clearTimeout(this.pingDeadlineTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pingTimer = null;
    this.pingDeadlineTimer = null;
    this.heartbeatTimer = null;
  }

  async handle(msg: IrcMessage): Promise<void> {
    switch (msg.command) {
      case "PASS":
        return this.onPass(msg);
      case "NICK":
        return this.onNick(msg);
      case "USER":
        return this.onUser(msg);
      case "CAP":
        return this.onCap(msg);
      case "PING":
        return this.onPing(msg);
      case "PONG":
        return this.onPong(msg);
      case "QUIT":
        await this.close(`Quit: ${msg.params[0] ?? "client quit"}`);
        return;
      case "JOIN":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onJoin(msg);
      case "PART":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onPart(msg);
      case "PRIVMSG":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onPrivmsg(msg);
      case "NAMES":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onNames(msg);
      case "LIST":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onList(msg);
      case "TOPIC":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onTopic(msg);
      case "CHATHISTORY":
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
          return;
        }
        return this.onChatHistory(msg);
      default:
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
        } else {
          this.sendNumeric("421", [msg.command, "Unknown command"]);
        }
    }
  }

  private async onJoin(msg: IrcMessage): Promise<void> {
    if (msg.params.length < 1) {
      this.sendNumeric("461", ["JOIN", "Not enough parameters"]);
      return;
    }
    const targets = msg.params[0].split(",").map((s) => s.trim()).filter(Boolean);
    for (const channel of targets) {
      if (!isValidChannelName(channel)) {
        this.sendNumeric("403", [channel, "No such channel"]);
        continue;
      }
      if (this.joined.has(channel)) continue;
      const state = await addMember(channel, this.nick!);
      this.joined.set(channel, state.topicVersion);
      await this.ctx.hub.addChannelClient(channel, this);

      // Echo JOIN to self.
      this.sendRaw(this.userPrefix(), "JOIN", [channel]);

      // Topic numerics.
      if (state.topic && state.topic.length > 0) {
        this.sendNumeric("332", [channel, state.topic]);
        if (state.topicSetBy && state.topicSetAt) {
          this.send("333", [
            this.nick!,
            channel,
            state.topicSetBy,
            String(state.topicSetAt),
          ]);
        }
      } else {
        this.sendNumeric("331", [channel, "No topic is set"]);
      }

      // MOTD as channel NOTICE.
      if (state.motd && state.motd.length > 0) {
        for (const line of state.motd.split("\n")) {
          this.sendRaw(this.ctx.hostname, "NOTICE", [channel, line]);
        }
      }

      // NAMES.
      this.sendNumeric("353", ["=", channel, state.members.join(" ")]);
      this.sendNumeric("366", [channel, "End of /NAMES list"]);

      // Broadcast to other in-channel IRC clients.
      const prefix = this.userPrefix();
      for (const peer of this.ctx.hub.activeMembers(channel)) {
        if (peer === this) continue;
        peer.sendRaw(prefix, "JOIN", [channel]);
      }
    }
  }

  private async onPart(msg: IrcMessage): Promise<void> {
    if (msg.params.length < 1) {
      this.sendNumeric("461", ["PART", "Not enough parameters"]);
      return;
    }
    const targets = msg.params[0].split(",").map((s) => s.trim()).filter(Boolean);
    const reason = msg.params[1];
    for (const channel of targets) {
      if (!this.joined.has(channel)) {
        this.sendNumeric("442", [channel, "You're not on that channel"]);
        continue;
      }
      const prefix = this.userPrefix();
      // Broadcast PART (including to self) BEFORE detaching, so peers see it.
      for (const peer of this.ctx.hub.activeMembers(channel)) {
        peer.sendRaw(prefix, "PART", reason ? [channel, reason] : [channel]);
      }
      this.ctx.hub.removeChannelClient(channel, this);
      this.joined.delete(channel);
      try {
        await removeMember(channel, this.nick!);
      } catch {
        /* ignore */
      }
    }
  }

  private async onPrivmsg(msg: IrcMessage): Promise<void> {
    if (msg.params.length < 1) {
      this.sendNumeric("411", ["No recipient given (PRIVMSG)"]);
      return;
    }
    if (msg.params.length < 2 || msg.params[1].length === 0) {
      this.sendNumeric("412", ["No text to send"]);
      return;
    }
    const target = msg.params[0];
    const text = msg.params[1];
    if (target.startsWith("#")) {
      if (!isValidChannelName(target)) {
        this.sendNumeric("401", [target, "No such nick/channel"]);
        return;
      }
      if (!this.joined.has(target)) {
        this.sendNumeric("404", [target, "Cannot send to channel"]);
        return;
      }
      // Append per line; the file poller will deliver to other IRC members.
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        await appendChannelMessage(target, this.nick!, line);
      }
    } else {
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        await appendInboxMessage(target, this.nick!, line);
      }
      // Live delivery if recipient is connected here (inbox poller would also
      // pick it up, but a direct write keeps latency tight).
      const peer = this.ctx.clientsByNick.get(target.toLowerCase());
      if (peer) {
        for (const line of text.split("\n")) {
          if (line.length === 0) continue;
          peer.sendRaw(this.userPrefix(), "PRIVMSG", [target, line]);
        }
      }
    }
  }

  private async onNames(msg: IrcMessage): Promise<void> {
    const list = msg.params[0]
      ? msg.params[0].split(",").map((s) => s.trim()).filter(Boolean)
      : [...this.joined.keys()];
    for (const channel of list) {
      if (!isValidChannelName(channel)) continue;
      const state = await readChannel(channel);
      this.sendNumeric("353", ["=", channel, state.members.join(" ")]);
      this.sendNumeric("366", [channel, "End of /NAMES list"]);
    }
  }

  private async onList(msg: IrcMessage): Promise<void> {
    const requested = msg.params[0]
      ? msg.params[0].split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    this.sendNumeric("321", ["Channel", "Users  Name"]);
    const channels = requested ?? (await listChannels());
    for (const channel of channels) {
      if (!isValidChannelName(channel)) continue;
      const state = await readChannel(channel);
      this.sendNumeric("322", [
        channel,
        String(state.members.length),
        state.topic ?? "",
      ]);
    }
    this.sendNumeric("323", ["End of /LIST"]);
  }

  private async onTopic(msg: IrcMessage): Promise<void> {
    if (msg.params.length < 1) {
      this.sendNumeric("461", ["TOPIC", "Not enough parameters"]);
      return;
    }
    const channel = msg.params[0];
    if (!isValidChannelName(channel)) {
      this.sendNumeric("403", [channel, "No such channel"]);
      return;
    }
    if (msg.params.length === 1) {
      const state = await readChannel(channel);
      if (state.topic && state.topic.length > 0) {
        this.sendNumeric("332", [channel, state.topic]);
        if (state.topicSetBy && state.topicSetAt) {
          this.send("333", [
            this.nick!,
            channel,
            state.topicSetBy,
            String(state.topicSetAt),
          ]);
        }
      } else {
        this.sendNumeric("331", [channel, "No topic is set"]);
      }
      return;
    }
    if (!this.joined.has(channel)) {
      this.sendNumeric("442", [channel, "You're not on that channel"]);
      return;
    }
    const newTopic = msg.params[1];
    const expected = this.joined.get(channel) ?? 0;
    const result = await setTopic(channel, this.nick!, newTopic, expected);
    if (!result.ok) {
      this.joined.set(channel, result.current.topicVersion);
      const setter = result.current.topicSetBy ?? "another agent";
      this.sendRaw(this.ctx.hostname, "NOTICE", [
        channel,
        `topic changed by ${setter} — your TOPIC was rejected, /topic to see current`,
      ]);
      return;
    }
    this.joined.set(channel, result.state.topicVersion);
    const prefix = this.userPrefix();
    for (const peer of this.ctx.hub.activeMembers(channel)) {
      peer.sendRaw(prefix, "TOPIC", [channel, newTopic]);
      // peers must also refresh their topicVersion baseline for future sets.
      if (peer !== this && peer.joined.has(channel)) {
        peer.joined.set(channel, result.state.topicVersion);
      }
    }
  }

  private async onPass(msg: IrcMessage): Promise<void> {
    if (this.state === "REGISTERED") {
      this.sendNumeric("462", ["You may not reregister"]);
      return;
    }
    if (msg.params.length < 1) {
      this.sendNumeric("461", ["PASS", "Not enough parameters"]);
      return;
    }
    this.passSubmitted = msg.params[0];
  }

  private async onNick(msg: IrcMessage): Promise<void> {
    if (msg.params.length < 1 || msg.params[0].length === 0) {
      this.sendNumeric("431", ["No nickname given"]);
      return;
    }
    if (this.state === "REGISTERED") {
      this.sendNumeric("462", ["You may not reregister"]);
      return;
    }
    const candidate = msg.params[0];
    if (!NICK_RE.test(candidate)) {
      this.sendNumeric("432", [candidate, "Erroneous nickname"]);
      return;
    }
    if (await this.isNickTaken(candidate)) {
      this.sendNumeric("433", [candidate, "Nickname is already in use"]);
      return;
    }
    this.nick = candidate;
    await this.maybeComplete();
  }

  private async onUser(msg: IrcMessage): Promise<void> {
    if (this.state === "REGISTERED") {
      this.sendNumeric("462", ["You may not reregister"]);
      return;
    }
    // USER <user> <mode> <unused> :<realname>
    if (msg.params.length < 4) {
      this.sendNumeric("461", ["USER", "Not enough parameters"]);
      return;
    }
    this.user = msg.params[0];
    this.realname = msg.params[3];
    await this.maybeComplete();
  }

  private async onCap(msg: IrcMessage): Promise<void> {
    const sub = (msg.params[0] ?? "").toUpperCase();
    switch (sub) {
      case "LS":
        this.capNegotiating = true;
        this.send("CAP", [this.nick ?? "*", "LS", SUPPORTED_CAPS.join(" ")]);
        return;
      case "REQ": {
        const reqStr = msg.params[1] ?? "";
        const requested = reqStr.split(" ").filter(Boolean);
        this.capsRequested = requested;
        const allOk = requested.every((c) => SUPPORTED_CAPS.includes(c));
        if (allOk) {
          for (const c of requested) this.caps.add(c);
        }
        this.send("CAP", [
          this.nick ?? "*",
          allOk ? "ACK" : "NAK",
          requested.join(" "),
        ]);
        return;
      }
      case "LIST":
        this.send("CAP", [this.nick ?? "*", "LIST", [...this.caps].join(" ")]);
        return;
      case "END":
        this.capNegotiating = false;
        await this.maybeComplete();
        return;
      default:
        // unknown subcommand — ignore
        return;
    }
  }

  private async onPing(msg: IrcMessage): Promise<void> {
    const token = msg.params[0] ?? "";
    this.send("PONG", [this.ctx.hostname, token]);
  }

  private async onPong(msg: IrcMessage): Promise<void> {
    const token = msg.params[msg.params.length - 1];
    if (this.pingToken && token === this.pingToken) {
      this.lastPongTs = Date.now();
      this.pingToken = null;
      if (this.pingDeadlineTimer) {
        clearTimeout(this.pingDeadlineTimer);
        this.pingDeadlineTimer = null;
      }
    }
  }

  private async isNickTaken(candidate: string): Promise<boolean> {
    const lower = candidate.toLowerCase();
    if (this.ctx.clientsByNick.has(lower)) return true;
    const existing = await listAgentIds();
    return existing.some((id) => id.toLowerCase() === lower);
  }

  private async maybeComplete(): Promise<void> {
    if (this.state === "REGISTERED") return;
    if (this.capNegotiating) return;
    if (!this.nick || !this.user || !this.realname) return;

    const expected = await readServerPass();
    if (expected !== null) {
      if (this.passSubmitted === null) {
        this.sendNumeric("464", ["Password required"]);
        this.close("Password required");
        return;
      }
      if (!timingEq(this.passSubmitted, expected)) {
        this.sendNumeric("464", ["Password incorrect"]);
        this.close("Password incorrect");
        return;
      }
    }

    // Final collision recheck under the live map (race-protect between NICK and complete).
    if (await this.isNickTaken(this.nick)) {
      this.sendNumeric("433", [this.nick, "Nickname is already in use"]);
      this.close("Nickname collision at completion");
      return;
    }

    this.state = "REGISTERED";
    this.ctx.clientsByNick.set(this.nick.toLowerCase(), this);

    const host = this.ctx.hostname;
    const version = this.ctx.version;

    this.sendNumeric("001", [`Welcome to the agent-coord bus, ${this.nick}!`]);
    this.sendNumeric("002", [`Your host is ${host}, running agent-coord-irc ${version}`]);
    this.sendNumeric("003", [`This server was created ${this.ctx.startedAtIso}`]);
    this.send("004", [this.nick, host, `agent-coord-irc/${version}`, "o", "nt"]);
    this.send("005", [
      this.nick,
      "NETWORK=agent-coord",
      "CHANTYPES=#",
      "NICKLEN=32",
      `CHATHISTORY=${CHATHISTORY_MAX}`,
      "are supported",
    ]);
    this.sendNumeric("422", ["MOTD File is missing"]);

    await upsertAgent({
      agentId: this.nick,
      role: this.realname,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      capabilities: ["irc-attached"],
    });

    await this.ctx.hub.addInboxClient(this);
    this.startTimers();
  }

  private chatHistoryError(sub: string, target: string | undefined, msg: string): void {
    const params = target ? [this.nick!, "CHATHISTORY", sub, target, msg] : [this.nick!, "CHATHISTORY", sub, msg];
    this.send("400", params);
  }

  private async onChatHistory(msg: IrcMessage): Promise<void> {
    if (!this.caps.has("draft/chathistory")) {
      this.sendNumeric("421", ["CHATHISTORY", "Unknown command"]);
      return;
    }
    const sub = (msg.params[0] ?? "").toUpperCase();
    if (!sub) {
      this.send("400", [this.nick!, "CHATHISTORY", "Subcommand required"]);
      return;
    }
    if (sub === "AROUND" || sub === "TARGETS") {
      this.chatHistoryError(sub, undefined, "Subcommand not implemented");
      return;
    }
    if (!["LATEST", "BEFORE", "AFTER", "BETWEEN"].includes(sub)) {
      this.chatHistoryError(sub, undefined, "Unknown subcommand");
      return;
    }
    const target = msg.params[1];
    if (!target) {
      this.sendNumeric("461", ["CHATHISTORY", sub, "Not enough parameters"]);
      return;
    }

    // Resolve target → entries.
    let entries: { id?: string; ts: number; from: string; text: string }[];
    if (target.startsWith("#")) {
      if (!this.joined.has(target)) {
        this.sendNumeric("442", [target, "You're not on that channel"]);
        return;
      }
      entries = await loadChannelHistory(target);
    } else {
      if (target.toLowerCase() !== this.nick!.toLowerCase()) {
        this.chatHistoryError(sub, target, "Cannot fetch other users' history");
        return;
      }
      entries = await loadInboxHistory(this.nick!);
    }

    // Parse criteria + limit.
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

    let result: typeof entries = [];
    if (sub === "LATEST") {
      const criterion = msg.params[2] ?? "*";
      const limit = parseLimit(msg.params[3] ?? "");
      if (limit === null) {
        this.chatHistoryError(sub, target, "Invalid limit");
        return;
      }
      if (criterion === "*") {
        result = entries.slice(-limit);
      } else {
        const ts = parseTs(criterion);
        if (ts === null) {
          this.chatHistoryError(sub, target, "Invalid timestamp format");
          return;
        }
        result = entries.filter((e) => e.ts > ts).slice(-limit);
      }
    } else if (sub === "BEFORE") {
      const ts = parseTs(msg.params[2] ?? "");
      const limit = parseLimit(msg.params[3] ?? "");
      if (ts === null) {
        this.chatHistoryError(sub, target, "Invalid timestamp format");
        return;
      }
      if (limit === null) {
        this.chatHistoryError(sub, target, "Invalid limit");
        return;
      }
      result = entries.filter((e) => e.ts < ts).slice(-limit);
    } else if (sub === "AFTER") {
      const ts = parseTs(msg.params[2] ?? "");
      const limit = parseLimit(msg.params[3] ?? "");
      if (ts === null) {
        this.chatHistoryError(sub, target, "Invalid timestamp format");
        return;
      }
      if (limit === null) {
        this.chatHistoryError(sub, target, "Invalid limit");
        return;
      }
      result = entries.filter((e) => e.ts > ts).slice(0, limit);
    } else if (sub === "BETWEEN") {
      const ts1 = parseTs(msg.params[2] ?? "");
      const ts2 = parseTs(msg.params[3] ?? "");
      const limit = parseLimit(msg.params[4] ?? "");
      if (ts1 === null || ts2 === null) {
        this.chatHistoryError(sub, target, "Invalid timestamp format");
        return;
      }
      if (limit === null) {
        this.chatHistoryError(sub, target, "Invalid limit");
        return;
      }
      const lo = Math.min(ts1, ts2);
      const hi = Math.max(ts1, ts2);
      result = entries.filter((e) => e.ts > lo && e.ts < hi).slice(0, limit);
    }

    this.emitChatHistory(target, result);
  }

  private emitChatHistory(
    target: string,
    entries: { ts: number; from: string; text: string }[],
  ): void {
    const useBatch = this.caps.has("batch");
    const useTime = this.caps.has("server-time");
    const batchId = randomBytes(6).toString("hex");
    if (useBatch) {
      this.send("BATCH", [`+${batchId}`, "chathistory", target]);
    }
    for (const entry of entries) {
      const iso = new Date(entry.ts).toISOString();
      const prefix = `${entry.from}!${entry.from}@coord`;
      const lines = entry.text.split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        const tags: Record<string, string> = {};
        if (useTime) tags["time"] = iso;
        if (useBatch) tags["batch"] = batchId;
        if (this.closed) return;
        this.socket.write(formatLineWithTags(tags, prefix, "PRIVMSG", [target, line]));
      }
    }
    if (useBatch) {
      this.send("BATCH", [`-${batchId}`]);
    }
  }

  private startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.nick) void bumpHeartbeat(this.nick);
    }, HEARTBEAT_MS);

    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.pingToken = `t${Date.now().toString(36)}`;
      this.send("PING", [this.pingToken]);
      this.pingDeadlineTimer = setTimeout(() => {
        if (this.pingToken !== null) {
          this.close("Ping timeout");
        }
      }, PING_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }
}

function timingEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
