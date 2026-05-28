import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

export const COORD_DIR = process.env.AGENT_COORD_DIR ?? path.join(os.homedir(), "agent-coord");
export const AGENTS_FILE = path.join(COORD_DIR, "agents.json");
export const SERVER_PASS_FILE = path.join(COORD_DIR, "server-pass");

export interface AgentEntry {
  agentId: string;
  project?: string;
  role?: string;
  registeredAt: number;
  lastHeartbeat: number;
  capabilities?: string[];
}

type AgentsMap = Record<string, AgentEntry>;

async function ensureFile(file: string): Promise<void> {
  if (!existsSync(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}", "utf8");
  }
}

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await ensureFile(file);
  const release = await lockfile.lock(file, {
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 5000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function readMap(): Promise<AgentsMap> {
  if (!existsSync(AGENTS_FILE)) return {};
  try {
    const raw = await fs.readFile(AGENTS_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as AgentsMap;
  } catch {
    return {};
  }
}

async function writeMap(map: AgentsMap): Promise<void> {
  await fs.writeFile(AGENTS_FILE, JSON.stringify(map, null, 2), "utf8");
}

export async function upsertAgent(entry: AgentEntry): Promise<void> {
  await withLock(AGENTS_FILE, async () => {
    const map = await readMap();
    map[entry.agentId] = entry;
    await writeMap(map);
  });
}

export async function removeAgent(agentId: string): Promise<void> {
  await withLock(AGENTS_FILE, async () => {
    const map = await readMap();
    if (map[agentId]) {
      delete map[agentId];
      await writeMap(map);
    }
  });
}

export async function bumpHeartbeat(agentId: string): Promise<void> {
  await withLock(AGENTS_FILE, async () => {
    const map = await readMap();
    const entry = map[agentId];
    if (entry) {
      entry.lastHeartbeat = Date.now();
      await writeMap(map);
    }
  });
}

export async function listAgentIds(): Promise<string[]> {
  const map = await readMap();
  return Object.keys(map);
}

export async function readServerPass(): Promise<string | null> {
  if (!existsSync(SERVER_PASS_FILE)) return null;
  try {
    const raw = await fs.readFile(SERVER_PASS_FILE, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
