import type { IrcMessage } from "../protocol.js";
import {
  addMember,
  appendChannelMessage,
  appendInboxMessage,
  isValidChannelName,
  listChannels,
  readChannel,
  removeMember,
  setTopic,
} from "../channels.js";
import type { Client } from "./index.js";

export async function handleJoin(c: Client, msg: IrcMessage): Promise<void> {
  if (msg.params.length < 1) {
    c.sendNumeric("461", ["JOIN", "Not enough parameters"]);
    return;
  }
  const targets = msg.params[0].split(",").map((s) => s.trim()).filter(Boolean);
  for (const channel of targets) {
    if (!isValidChannelName(channel)) {
      c.sendNumeric("403", [channel, "No such channel"]);
      continue;
    }
    if (c.joined.has(channel)) continue;
    const state = await addMember(channel, c.nick!);
    c.joined.set(channel, state.topicVersion);
    await c.ctx.hub.addChannelClient(channel, c);

    c.sendRaw(c.userPrefix(), "JOIN", [channel]);

    if (state.topic && state.topic.length > 0) {
      c.sendNumeric("332", [channel, state.topic]);
      if (state.topicSetBy && state.topicSetAt) {
        c.send("333", [c.nick!, channel, state.topicSetBy, String(state.topicSetAt)]);
      }
    } else {
      c.sendNumeric("331", [channel, "No topic is set"]);
    }

    if (state.motd && state.motd.length > 0) {
      for (const line of state.motd.split("\n")) {
        c.sendRaw(c.ctx.hostname, "NOTICE", [channel, line]);
      }
    }

    c.sendNumeric("353", ["=", channel, state.members.join(" ")]);
    c.sendNumeric("366", [channel, "End of /NAMES list"]);

    const prefix = c.userPrefix();
    for (const peer of c.ctx.hub.activeMembers(channel)) {
      if (peer === c) continue;
      peer.sendRaw(prefix, "JOIN", [channel]);
    }
  }
}

export async function handlePart(c: Client, msg: IrcMessage): Promise<void> {
  if (msg.params.length < 1) {
    c.sendNumeric("461", ["PART", "Not enough parameters"]);
    return;
  }
  const targets = msg.params[0].split(",").map((s) => s.trim()).filter(Boolean);
  const reason = msg.params[1];
  for (const channel of targets) {
    if (!c.joined.has(channel)) {
      c.sendNumeric("442", [channel, "You're not on that channel"]);
      continue;
    }
    const prefix = c.userPrefix();
    for (const peer of c.ctx.hub.activeMembers(channel)) {
      peer.sendRaw(prefix, "PART", reason ? [channel, reason] : [channel]);
    }
    c.ctx.hub.removeChannelClient(channel, c);
    c.joined.delete(channel);
    try {
      await removeMember(channel, c.nick!);
    } catch {
      /* ignore */
    }
  }
}

export async function handlePrivmsg(c: Client, msg: IrcMessage): Promise<void> {
  if (msg.params.length < 1) {
    c.sendNumeric("411", ["No recipient given (PRIVMSG)"]);
    return;
  }
  if (msg.params.length < 2 || msg.params[1].length === 0) {
    c.sendNumeric("412", ["No text to send"]);
    return;
  }
  const target = msg.params[0];
  const text = msg.params[1];
  if (target.startsWith("#")) {
    if (!isValidChannelName(target)) {
      c.sendNumeric("401", [target, "No such nick/channel"]);
      return;
    }
    if (!c.joined.has(target)) {
      c.sendNumeric("404", [target, "Cannot send to channel"]);
      return;
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      await appendChannelMessage(target, c.nick!, line);
    }
  } else {
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      await appendInboxMessage(target, c.nick!, line);
    }
    const peer = c.ctx.clientsByNick.get(target.toLowerCase());
    if (peer) {
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        peer.sendRaw(c.userPrefix(), "PRIVMSG", [target, line]);
      }
    }
  }
}

export async function handleNames(c: Client, msg: IrcMessage): Promise<void> {
  const list = msg.params[0]
    ? msg.params[0].split(",").map((s) => s.trim()).filter(Boolean)
    : [...c.joined.keys()];
  for (const channel of list) {
    if (!isValidChannelName(channel)) continue;
    const state = await readChannel(channel);
    c.sendNumeric("353", ["=", channel, state.members.join(" ")]);
    c.sendNumeric("366", [channel, "End of /NAMES list"]);
  }
}

export async function handleList(c: Client, msg: IrcMessage): Promise<void> {
  const requested = msg.params[0]
    ? msg.params[0].split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  c.sendNumeric("321", ["Channel", "Users  Name"]);
  const channels = requested ?? (await listChannels());
  for (const channel of channels) {
    if (!isValidChannelName(channel)) continue;
    const state = await readChannel(channel);
    c.sendNumeric("322", [channel, String(state.members.length), state.topic ?? ""]);
  }
  c.sendNumeric("323", ["End of /LIST"]);
}

export async function handleTopic(c: Client, msg: IrcMessage): Promise<void> {
  if (msg.params.length < 1) {
    c.sendNumeric("461", ["TOPIC", "Not enough parameters"]);
    return;
  }
  const channel = msg.params[0];
  if (!isValidChannelName(channel)) {
    c.sendNumeric("403", [channel, "No such channel"]);
    return;
  }
  if (msg.params.length === 1) {
    const state = await readChannel(channel);
    if (state.topic && state.topic.length > 0) {
      c.sendNumeric("332", [channel, state.topic]);
      if (state.topicSetBy && state.topicSetAt) {
        c.send("333", [c.nick!, channel, state.topicSetBy, String(state.topicSetAt)]);
      }
    } else {
      c.sendNumeric("331", [channel, "No topic is set"]);
    }
    return;
  }
  if (!c.joined.has(channel)) {
    c.sendNumeric("442", [channel, "You're not on that channel"]);
    return;
  }
  const newTopic = msg.params[1];
  const expected = c.joined.get(channel) ?? 0;
  const result = await setTopic(channel, c.nick!, newTopic, expected);
  if (!result.ok) {
    c.joined.set(channel, result.current.topicVersion);
    const setter = result.current.topicSetBy ?? "another agent";
    c.sendRaw(c.ctx.hostname, "NOTICE", [
      channel,
      `topic changed by ${setter} — your TOPIC was rejected, /topic to see current`,
    ]);
    return;
  }
  c.joined.set(channel, result.state.topicVersion);
  const prefix = c.userPrefix();
  for (const peer of c.ctx.hub.activeMembers(channel)) {
    peer.sendRaw(prefix, "TOPIC", [channel, newTopic]);
    if (peer !== c && peer.joined.has(channel)) {
      peer.joined.set(channel, result.state.topicVersion);
    }
  }
}
