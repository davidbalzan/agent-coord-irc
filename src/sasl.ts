import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { COORD_DIR } from "./registry.js";

export const SASL_USERS_FILE = path.join(COORD_DIR, "sasl-users.json");

type Users = Record<string, string>;

export function saslUsersFileExists(): boolean {
  return existsSync(SASL_USERS_FILE);
}

/**
 * Warn (once) on stderr if the credentials file mode is more permissive
 * than 0600. Non-fatal — the user might be running on a system without
 * meaningful POSIX modes.
 */
let modeWarned = false;
export function maybeWarnSaslFileMode(): void {
  if (modeWarned || !existsSync(SASL_USERS_FILE)) return;
  modeWarned = true;
  try {
    const s = statSync(SASL_USERS_FILE);
    const perms = s.mode & 0o777;
    if (perms & 0o077) {
      process.stderr.write(
        `⚠  ${SASL_USERS_FILE} mode is ${perms.toString(8)} — recommend 600 (\`chmod 600 ${SASL_USERS_FILE}\`)\n`,
      );
    }
  } catch {
    /* ignore */
  }
}

async function readUsers(): Promise<Users> {
  if (!existsSync(SASL_USERS_FILE)) return {};
  try {
    const raw = await fs.readFile(SASL_USERS_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Users;
  } catch {
    return {};
  }
}

/**
 * Verify a SASL PLAIN blob against `~/agent-coord/sasl-users.json`.
 * Returns the authcid on success, null on failure (unknown user / bad password).
 */
export async function verifySaslPlain(blob: Buffer): Promise<string | null> {
  // blob = authzid\0authcid\0password
  const parts = splitNulls(blob);
  if (parts.length !== 3) return null;
  const authcid = parts[1].toString("utf8");
  const password = parts[2].toString("utf8");
  if (!authcid || !password) return null;

  const users = await readUsers();
  const expected = users[authcid];
  if (typeof expected !== "string") return null;
  if (!timingEq(password, expected)) return null;
  return authcid;
}

function splitNulls(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  out.push(buf.subarray(start));
  return out;
}

function timingEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
