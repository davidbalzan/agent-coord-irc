import { timingSafeEqual } from "node:crypto";
import type { IrcMessage } from "../protocol.js";
import { listAgentIds, readServerPass, upsertAgent } from "../registry.js";
import type { Client } from "./index.js";
import { CHATHISTORY_MAX } from "./chathistory.js";

const NICK_RE = /^[A-Za-z][A-Za-z0-9._\-]{0,31}$/;

export const SUPPORTED_CAPS = [
  "message-tags",
  "server-time",
  "batch",
  "draft/chathistory",
];

export async function handlePass(c: Client, msg: IrcMessage): Promise<void> {
  if (c.state === "REGISTERED") {
    c.sendNumeric("462", ["You may not reregister"]);
    return;
  }
  if (msg.params.length < 1) {
    c.sendNumeric("461", ["PASS", "Not enough parameters"]);
    return;
  }
  c.passSubmitted = msg.params[0];
}

export async function handleNick(c: Client, msg: IrcMessage): Promise<void> {
  if (msg.params.length < 1 || msg.params[0].length === 0) {
    c.sendNumeric("431", ["No nickname given"]);
    return;
  }
  if (c.state === "REGISTERED") {
    c.sendNumeric("462", ["You may not reregister"]);
    return;
  }
  const candidate = msg.params[0];
  if (!NICK_RE.test(candidate)) {
    c.sendNumeric("432", [candidate, "Erroneous nickname"]);
    return;
  }
  if (await isNickTaken(c, candidate)) {
    c.sendNumeric("433", [candidate, "Nickname is already in use"]);
    return;
  }
  c.nick = candidate;
  await maybeComplete(c);
}

export async function handleUser(c: Client, msg: IrcMessage): Promise<void> {
  if (c.state === "REGISTERED") {
    c.sendNumeric("462", ["You may not reregister"]);
    return;
  }
  if (msg.params.length < 4) {
    c.sendNumeric("461", ["USER", "Not enough parameters"]);
    return;
  }
  c.user = msg.params[0];
  c.realname = msg.params[3];
  await maybeComplete(c);
}

export async function handleCap(c: Client, msg: IrcMessage): Promise<void> {
  const sub = (msg.params[0] ?? "").toUpperCase();
  switch (sub) {
    case "LS":
      c.capNegotiating = true;
      c.send("CAP", [c.nick ?? "*", "LS", SUPPORTED_CAPS.join(" ")]);
      return;
    case "REQ": {
      const reqStr = msg.params[1] ?? "";
      const requested = reqStr.split(" ").filter(Boolean);
      c.capsRequested = requested;
      const allOk = requested.every((cap) => SUPPORTED_CAPS.includes(cap));
      if (allOk) {
        for (const cap of requested) c.caps.add(cap);
      }
      c.send("CAP", [c.nick ?? "*", allOk ? "ACK" : "NAK", requested.join(" ")]);
      return;
    }
    case "LIST":
      c.send("CAP", [c.nick ?? "*", "LIST", [...c.caps].join(" ")]);
      return;
    case "END":
      c.capNegotiating = false;
      await maybeComplete(c);
      return;
    default:
      return;
  }
}

export async function handlePing(c: Client, msg: IrcMessage): Promise<void> {
  const token = msg.params[0] ?? "";
  c.send("PONG", [c.ctx.hostname, token]);
}

export async function handlePong(c: Client, msg: IrcMessage): Promise<void> {
  const token = msg.params[msg.params.length - 1];
  c.acknowledgePong(token);
}

async function isNickTaken(c: Client, candidate: string): Promise<boolean> {
  const lower = candidate.toLowerCase();
  if (c.ctx.clientsByNick.has(lower)) return true;
  const existing = await listAgentIds();
  return existing.some((id) => id.toLowerCase() === lower);
}

async function maybeComplete(c: Client): Promise<void> {
  if (c.state === "REGISTERED") return;
  if (c.capNegotiating) return;
  if (!c.nick || !c.user || !c.realname) return;

  const expected = await readServerPass();
  if (expected !== null) {
    if (c.passSubmitted === null) {
      c.sendNumeric("464", ["Password required"]);
      await c.close("Password required");
      return;
    }
    if (!timingEq(c.passSubmitted, expected)) {
      c.sendNumeric("464", ["Password incorrect"]);
      await c.close("Password incorrect");
      return;
    }
  }

  if (await isNickTaken(c, c.nick)) {
    c.sendNumeric("433", [c.nick, "Nickname is already in use"]);
    await c.close("Nickname collision at completion");
    return;
  }

  c.state = "REGISTERED";
  c.ctx.clientsByNick.set(c.nick.toLowerCase(), c);

  const host = c.ctx.hostname;
  const version = c.ctx.version;

  c.sendNumeric("001", [`Welcome to the agent-coord bus, ${c.nick}!`]);
  c.sendNumeric("002", [`Your host is ${host}, running agent-coord-irc ${version}`]);
  c.sendNumeric("003", [`This server was created ${c.ctx.startedAtIso}`]);
  c.send("004", [c.nick, host, `agent-coord-irc/${version}`, "o", "nt"]);
  c.send("005", [
    c.nick,
    "NETWORK=agent-coord",
    "CHANTYPES=#",
    "NICKLEN=32",
    `CHATHISTORY=${CHATHISTORY_MAX}`,
    "are supported",
  ]);
  c.sendNumeric("422", ["MOTD File is missing"]);

  await upsertAgent({
    agentId: c.nick,
    role: c.realname,
    registeredAt: Date.now(),
    lastHeartbeat: Date.now(),
    capabilities: ["irc-attached"],
  });

  await c.ctx.hub.addInboxClient(c);
  c.startTimers();
}

function timingEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
