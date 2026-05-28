import type { Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { formatLine, type IrcMessage } from "./protocol.js";
import {
  upsertAgent,
  removeAgent,
  bumpHeartbeat,
  listAgentIds,
  readServerPass,
} from "./registry.js";

export type ClientState = "PENDING" | "CAP_NEGOTIATING" | "REGISTERED";

const NICK_RE = /^[A-Za-z][A-Za-z0-9._\-]{0,31}$/;
const HEARTBEAT_MS = 30_000;
const PING_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 30_000;

// Empty cap list for now — message-tags / server-time / chathistory come later.
const SUPPORTED_CAPS: string[] = [];

export interface ServerContext {
  hostname: string;
  version: string;
  startedAtIso: string;
  clientsByNick: Map<string, Client>; // lowercase nick → client
}

export class Client {
  state: ClientState = "PENDING";
  nick: string | null = null;
  user: string | null = null;
  realname: string | null = null;
  passSubmitted: string | null = null;
  capNegotiating = false;
  capsRequested: string[] = [];
  buf = "";
  closed = false;

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

  sendNumeric(code: string, params: string[]): void {
    const target = this.nick ?? "*";
    this.send(code, [target, ...params]);
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
      default:
        if (this.state !== "REGISTERED") {
          this.sendNumeric("451", ["You have not registered"]);
        } else {
          // Unimplemented in task 2 — channels/messages come in task 3.
          this.sendNumeric("421", [msg.command, "Unknown command"]);
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
      case "LIST":
        this.send("CAP", [this.nick ?? "*", "LIST", ""]);
        return;
      case "REQ": {
        const reqStr = msg.params[1] ?? "";
        const requested = reqStr.split(" ").filter(Boolean);
        this.capsRequested = requested;
        // Empty supported set → NAK anything requested (none for now).
        const allOk = requested.every((c) => SUPPORTED_CAPS.includes(c));
        this.send("CAP", [
          this.nick ?? "*",
          allOk ? "ACK" : "NAK",
          requested.join(" "),
        ]);
        return;
      }
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

    this.startTimers();
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
