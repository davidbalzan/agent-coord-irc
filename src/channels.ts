import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { COORD_DIR } from "./registry.js";

export const ROOMS_DIR = path.join(COORD_DIR, "rooms");
export const INBOX_DIR = path.join(COORD_DIR, "inbox");

const CHAN_NAME_RE = /^#[A-Za-z0-9._\-]{1,32}$/;

export function isValidChannelName(name: string): boolean {
  return CHAN_NAME_RE.test(name);
}

export function channelBase(name: string): string {
  return name.startsWith("#") ? name.slice(1) : name;
}

export function channelJsonPath(name: string): string {
  return path.join(ROOMS_DIR, channelBase(name) + ".json");
}

export function channelJsonlPath(name: string): string {
  return path.join(ROOMS_DIR, channelBase(name) + ".jsonl");
}

export function inboxJsonlPath(nick: string): string {
  return path.join(INBOX_DIR, nick + ".jsonl");
}

export interface ChannelMessage {
  id: string;
  ts: number;
  from: string;
  room?: string;
  to?: string;
  text: string;
}

export interface ChannelState {
  name: string; // includes "#"
  topic?: string;
  topicSetBy?: string;
  topicSetAt?: number; // seconds since epoch
  topicVersion: number;
  motd?: string;
  motdSetBy?: string;
  motdSetAt?: number;
  members: string[];
  createdAt: number;
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

const LOCK_OPTS = {
  retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
  stale: 5000,
};

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", "utf8");
  }
  const release = await lockfile.lock(file, LOCK_OPTS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function ensureChannel(name: string): Promise<ChannelState> {
  await fs.mkdir(ROOMS_DIR, { recursive: true });
  const stateFile = channelJsonPath(name);
  const jsonlFile = channelJsonlPath(name);
  if (!existsSync(stateFile)) {
    const init: ChannelState = {
      name,
      topicVersion: 0,
      members: [],
      createdAt: Date.now(),
    };
    await fs.writeFile(stateFile, JSON.stringify(init, null, 2), "utf8");
  }
  if (!existsSync(jsonlFile)) {
    await fs.writeFile(jsonlFile, "", "utf8");
  }
  return readChannel(name);
}

export async function readChannel(name: string): Promise<ChannelState> {
  const file = channelJsonPath(name);
  if (!existsSync(file)) {
    return ensureChannel(name);
  }
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as ChannelState;
  } catch {
    return ensureChannel(name);
  }
}

async function writeChannel(state: ChannelState): Promise<void> {
  await fs.writeFile(channelJsonPath(state.name), JSON.stringify(state, null, 2), "utf8");
}

export async function listChannels(): Promise<string[]> {
  if (!existsSync(ROOMS_DIR)) return [];
  const entries = await fs.readdir(ROOMS_DIR);
  return entries
    .filter((n) => n.endsWith(".json") && !n.endsWith(".jsonl"))
    .map((n) => "#" + n.slice(0, -".json".length));
}

export async function addMember(channel: string, nick: string): Promise<ChannelState> {
  await ensureChannel(channel);
  return withLock(channelJsonPath(channel), async () => {
    const state = await readChannel(channel);
    if (!state.members.includes(nick)) state.members.push(nick);
    await writeChannel(state);
    return state;
  });
}

export async function removeMember(channel: string, nick: string): Promise<ChannelState | null> {
  if (!existsSync(channelJsonPath(channel))) return null;
  return withLock(channelJsonPath(channel), async () => {
    const state = await readChannel(channel);
    state.members = state.members.filter((m) => m !== nick);
    await writeChannel(state);
    return state;
  });
}

export type TopicSetResult =
  | { ok: true; state: ChannelState }
  | { ok: false; current: ChannelState };

export async function setTopic(
  channel: string,
  nick: string,
  topic: string,
  expectedVersion: number,
): Promise<TopicSetResult> {
  await ensureChannel(channel);
  return withLock(channelJsonPath(channel), async () => {
    const state = await readChannel(channel);
    if (state.topicVersion !== expectedVersion) {
      return { ok: false as const, current: state };
    }
    state.topic = topic;
    state.topicSetBy = nick;
    state.topicSetAt = Math.floor(Date.now() / 1000);
    state.topicVersion += 1;
    await writeChannel(state);
    return { ok: true as const, state };
  });
}

export async function appendChannelMessage(
  channel: string,
  from: string,
  text: string,
): Promise<ChannelMessage> {
  await ensureChannel(channel);
  const entry: ChannelMessage = {
    id: newId(),
    ts: Date.now(),
    from,
    room: channelBase(channel),
    text,
  };
  const file = channelJsonlPath(channel);
  await withLock(file, async () => {
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  });
  return entry;
}

export async function appendInboxMessage(
  toNick: string,
  from: string,
  text: string,
): Promise<ChannelMessage> {
  await fs.mkdir(INBOX_DIR, { recursive: true });
  const file = inboxJsonlPath(toNick);
  const entry: ChannelMessage = {
    id: newId(),
    ts: Date.now(),
    from,
    to: toNick,
    text,
  };
  if (!existsSync(file)) await fs.writeFile(file, "", "utf8");
  await withLock(file, async () => {
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  });
  return entry;
}
