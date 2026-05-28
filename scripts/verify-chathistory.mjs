#!/usr/bin/env node
// Verification for task 4 (CHATHISTORY).
//
// Scenarios:
//   1. LATEST with batch+server-time → BATCH wrapper + @time tags.
//   2. Cross-bridge: a freshly-posted MCP-style entry in rooms/general.jsonl
//      shows up in LATEST replay with its original timestamp.
//   3. Legacy bleed-through: an entry in legacy room.jsonl shows up in
//      LATEST for #general.
//   4. DM scope: alice asks for her own inbox history → ok; asks for bob's
//      history → 400 ... Cannot fetch other users' history.
//   5. BEFORE timestamp pagination.
//   6. CHATHISTORY without `draft/chathistory` cap → 421.
//   7. CHATHISTORY with cap but without `batch` cap → messages but no
//      BATCH wrapper.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connect } from "node:net";

const SERVER = path.resolve(new URL("../dist/server.js", import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(coordDir, fn) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AGENT_COORD_DIR: coordDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString()));
  await new Promise((res) => {
    const onData = (b) => {
      if (b.toString().includes("listening")) {
        child.stderr.off("data", onData);
        res();
      }
    };
    child.stderr.on("data", onData);
  });
  try {
    return await fn();
  } finally {
    child.kill("SIGTERM");
    await new Promise((res) => child.on("exit", res));
    if (process.env.VERBOSE) process.stderr.write(`[server]\n${stderr}\n`);
  }
}

class IrcClient {
  constructor() {
    this.lines = [];
    this.buf = "";
    this.closed = false;
  }
  async connect() {
    return new Promise((res, rej) => {
      this.sock = connect(6667, "127.0.0.1");
      this.sock.setEncoding("utf8");
      this.sock.on("data", (chunk) => {
        this.buf += chunk;
        let nl;
        while ((nl = this.buf.indexOf("\n")) !== -1) {
          let line = this.buf.slice(0, nl);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          this.buf = this.buf.slice(nl + 1);
          if (line.length > 0) this.lines.push(line);
        }
      });
      this.sock.on("close", () => (this.closed = true));
      this.sock.on("error", rej);
      this.sock.on("connect", res);
    });
  }
  write(line) {
    this.sock.write(line + "\r\n");
  }
  async register(nick, caps = "message-tags server-time batch draft/chathistory") {
    this.write("CAP LS 302");
    if (caps.length > 0) this.write("CAP REQ :" + caps);
    this.write("NICK " + nick);
    this.write("USER " + nick + " 0 * :" + nick);
    this.write("CAP END");
    await this.waitFor((l) => l.includes(" 422 "), 1500);
  }
  async waitFor(predicate, timeoutMs, fromIdx = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.lines.slice(fromIdx).some(predicate)) return true;
      await sleep(50);
    }
    return false;
  }
  close() {
    if (this.sock && !this.closed) {
      this.write("QUIT :bye");
      this.sock.end();
    }
  }
}

function newEntry(over) {
  return {
    id: "x" + Math.random().toString(16).slice(2, 10),
    ts: Date.now(),
    from: "coord-dev",
    room: "general",
    text: "history line",
    ...over,
  };
}

async function main() {
  const coordDir = mkdtempSync(path.join(tmpdir(), "coord-irc-task4-"));
  process.stdout.write(`coordDir=${coordDir}\n`);
  try {
    // Pre-populate JSONL files (server lazily creates these but we'll seed them).
    mkdirSync(path.join(coordDir, "rooms"), { recursive: true });
    mkdirSync(path.join(coordDir, "inbox"), { recursive: true });

    const generalFile = path.join(coordDir, "rooms", "general.jsonl");
    const legacyFile = path.join(coordDir, "room.jsonl");
    const aliceInbox = path.join(coordDir, "inbox", "alice.jsonl");

    // 5 main entries spread by ts, last one is the "MCP-posted" message we'll look for.
    const t0 = Date.now() - 60_000;
    const mainEntries = [
      newEntry({ from: "carol", ts: t0 + 1000, text: "earliest" }),
      newEntry({ from: "carol", ts: t0 + 2000, text: "second" }),
      newEntry({ from: "carol", ts: t0 + 3000, text: "third" }),
      newEntry({ from: "carol", ts: t0 + 4000, text: "fourth" }),
      newEntry({ from: "coord-dev", ts: t0 + 5000, text: "MCP-posted-history-test" }),
    ];
    writeFileSync(
      generalFile,
      mainEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    // Legacy entry (no `room` field).
    const legacy = { id: "leg1", ts: t0 - 1000, from: "david", text: "from-legacy-room" };
    writeFileSync(legacyFile, JSON.stringify(legacy) + "\n");
    // Alice DM inbox.
    const inboxEntries = [
      { id: "i1", ts: t0 + 100, from: "bob", to: "alice", text: "dm one" },
      { id: "i2", ts: t0 + 200, from: "bob", to: "alice", text: "dm two" },
    ];
    writeFileSync(
      aliceInbox,
      inboxEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await withServer(coordDir, async () => {
      // --- scenarios 1, 2, 3, 5 ---
      const alice = new IrcClient();
      await alice.connect();
      await alice.register("alice");
      alice.write("JOIN #general");
      await alice.waitFor((l) => l.includes(" 366 ") && l.includes("#general"), 1500);
      const baseLen = alice.lines.length;
      alice.write("CHATHISTORY LATEST #general * 50");
      await alice.waitFor(
        (l) => l.includes(" BATCH -") || l.includes("Subcommand not implemented"),
        2000,
      );
      const reply1 = alice.lines.slice(baseLen);
      process.stdout.write("\n[scenario 1+2+3] CHATHISTORY LATEST #general * 50\n");
      for (const l of reply1) process.stdout.write("  " + l + "\n");
      const hasBatchOpen = reply1.some((l) => /BATCH \+\w+ chathistory #general/.test(l));
      const hasBatchClose = reply1.some((l) => /BATCH -\w+/.test(l));
      const hasMcp = reply1.some(
        (l) => l.includes("MCP-posted-history-test") && /@time=\d{4}-/.test(l),
      );
      const hasLegacy = reply1.some((l) => l.includes("from-legacy-room"));
      process.stdout.write(`  BATCH open: ${hasBatchOpen}\n`);
      process.stdout.write(`  BATCH close: ${hasBatchClose}\n`);
      process.stdout.write(`  MCP-posted entry with @time tag: ${hasMcp}\n`);
      process.stdout.write(`  Legacy room.jsonl bleed-through: ${hasLegacy}\n`);

      // scenario 5: BEFORE
      const baseLenB = alice.lines.length;
      const beforeTs = new Date(t0 + 3500).toISOString();
      alice.write(`CHATHISTORY BEFORE #general timestamp=${beforeTs} 10`);
      await alice.waitFor((l) => l.includes(" BATCH -"), 1500, baseLenB);
      const reply5 = alice.lines.slice(baseLenB);
      process.stdout.write(`\n[scenario 5] BEFORE timestamp=${beforeTs} 10\n`);
      for (const l of reply5) process.stdout.write("  " + l + "\n");

      // scenario 4: DM scope
      const baseLenD = alice.lines.length;
      alice.write("CHATHISTORY LATEST alice * 20");
      await alice.waitFor((l) => l.includes(" BATCH -"), 1500, baseLenD);
      const dmOwn = alice.lines.slice(baseLenD);
      process.stdout.write("\n[scenario 4a] CHATHISTORY LATEST alice * 20 (own inbox)\n");
      for (const l of dmOwn) process.stdout.write("  " + l + "\n");

      const baseLenD2 = alice.lines.length;
      alice.write("CHATHISTORY LATEST bob * 20");
      await sleep(400);
      const dmOther = alice.lines.slice(baseLenD2);
      process.stdout.write("\n[scenario 4b] CHATHISTORY LATEST bob * 20 (someone else)\n");
      for (const l of dmOther) process.stdout.write("  " + l + "\n");

      alice.close();
      await sleep(200);

      // scenario 6: no cap → 421
      const noCap = new IrcClient();
      await noCap.connect();
      await noCap.register("nocap", ""); // no CAP REQ
      const base6 = noCap.lines.length;
      noCap.write("CHATHISTORY LATEST #general * 10");
      await sleep(400);
      const reply6 = noCap.lines.slice(base6);
      process.stdout.write("\n[scenario 6] CHATHISTORY without draft/chathistory cap\n");
      for (const l of reply6) process.stdout.write("  " + l + "\n");
      noCap.close();
      await sleep(200);

      // scenario 7: cap but no batch
      const noBatch = new IrcClient();
      await noBatch.connect();
      await noBatch.register("nobat", "message-tags server-time draft/chathistory");
      noBatch.write("JOIN #general");
      await noBatch.waitFor((l) => l.includes(" 366 ") && l.includes("#general"), 1500);
      const base7 = noBatch.lines.length;
      noBatch.write("CHATHISTORY LATEST #general * 3");
      await sleep(800);
      const reply7 = noBatch.lines.slice(base7);
      process.stdout.write("\n[scenario 7] cap but no batch (LATEST 3)\n");
      for (const l of reply7) process.stdout.write("  " + l + "\n");
      noBatch.close();
      await sleep(200);
    });
  } finally {
    if (!process.env.KEEP) rmSync(coordDir, { recursive: true, force: true });
    else process.stdout.write(`(kept ${coordDir})\n`);
  }
}

main().catch((e) => {
  process.stderr.write(e.stack + "\n");
  process.exit(1);
});
