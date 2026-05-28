import type { Socket } from "node:net";
import { formatLine, type IrcMessage } from "../protocol.js";
import { removeAgent, bumpHeartbeat } from "../registry.js";
import { removeMember } from "../channels.js";
import type { Hub } from "../hub.js";

import {
  handlePass,
  handleNick,
  handleUser,
  handleCap,
  handlePing,
  handlePong,
  handleAuthenticate,
} from "./handshake.js";
import {
  handleJoin,
  handlePart,
  handlePrivmsg,
  handleNames,
  handleList,
  handleTopic,
} from "./channels.js";
import { handleChatHistory } from "./chathistory.js";

export type ClientState = "PENDING" | "CAP_NEGOTIATING" | "REGISTERED";

export const HEARTBEAT_MS = 30_000;
export const PING_INTERVAL_MS = 60_000;
export const PING_TIMEOUT_MS = 30_000;

export interface ServerContext {
  hostname: string;
  version: string;
  startedAtIso: string;
  clientsByNick: Map<string, Client>; // lowercase nick → client
  allClients: Set<Client>;            // every connected client, regardless of state
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
  joined: Map<string, number> = new Map();

  /** Transport flag — set to true for clients on the TLS listener. */
  tls = false;
  /** SASL state. */
  saslMechanism: string | null = null;
  saslInProgress = false;
  saslAuthcid: string | null = null;
  saslAborted = false;

  lastPongTs = Date.now();
  pingToken: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingDeadlineTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(public socket: Socket, public ctx: ServerContext) {}

  send(command: string, params: string[], prefix?: string): void {
    if (this.closed) return;
    this.socket.write(formatLine(prefix ?? this.ctx.hostname, command, params));
  }

  sendRaw(prefix: string, command: string, params: string[]): void {
    if (this.closed) return;
    this.socket.write(formatLine(prefix, command, params));
  }

  sendNumeric(code: string, params: string[]): void {
    const target = this.nick ?? "*";
    this.send(code, [target, ...params]);
  }

  userPrefix(): string {
    const n = this.nick ?? "*";
    const u = this.user ?? n;
    return `${n}!${u}@coord`;
  }

  acknowledgePong(token: string): void {
    if (this.pingToken && token === this.pingToken) {
      this.lastPongTs = Date.now();
      this.pingToken = null;
      if (this.pingDeadlineTimer) {
        clearTimeout(this.pingDeadlineTimer);
        this.pingDeadlineTimer = null;
      }
    }
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ctx.allClients.delete(this);
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
      for (const channel of this.joined.keys()) {
        this.ctx.hub.removeChannelClient(channel, this);
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

  stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pingDeadlineTimer) clearTimeout(this.pingDeadlineTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pingTimer = null;
    this.pingDeadlineTimer = null;
    this.heartbeatTimer = null;
  }

  startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.nick) void bumpHeartbeat(this.nick);
    }, HEARTBEAT_MS);

    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.pingToken = `t${Date.now().toString(36)}`;
      this.send("PING", [this.pingToken]);
      this.pingDeadlineTimer = setTimeout(() => {
        if (this.pingToken !== null) {
          void this.close("Ping timeout");
        }
      }, PING_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  async handle(msg: IrcMessage): Promise<void> {
    const reg = this.state === "REGISTERED";
    switch (msg.command) {
      case "PASS":
        return handlePass(this, msg);
      case "NICK":
        return handleNick(this, msg);
      case "USER":
        return handleUser(this, msg);
      case "CAP":
        return handleCap(this, msg);
      case "AUTHENTICATE":
        return handleAuthenticate(this, msg);
      case "PING":
        return handlePing(this, msg);
      case "PONG":
        return handlePong(this, msg);
      case "QUIT":
        await this.close(`Quit: ${msg.params[0] ?? "client quit"}`);
        return;
      case "JOIN":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handleJoin(this, msg);
      case "PART":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handlePart(this, msg);
      case "PRIVMSG":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handlePrivmsg(this, msg);
      case "NAMES":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handleNames(this, msg);
      case "LIST":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handleList(this, msg);
      case "TOPIC":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handleTopic(this, msg);
      case "CHATHISTORY":
        if (!reg) { this.sendNumeric("451", ["You have not registered"]); return; }
        return handleChatHistory(this, msg);
      default:
        if (!reg) {
          this.sendNumeric("451", ["You have not registered"]);
        } else {
          this.sendNumeric("421", [msg.command, "Unknown command"]);
        }
    }
  }
}
