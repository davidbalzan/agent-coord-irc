#!/usr/bin/env node
// End-to-end verification for task 3 (channels + JSONL bridge).
//
// All scenarios use a temp AGENT_COORD_DIR so they don't pollute the real one.
// Scenarios:
//   1. alice JOIN #general, bob JOIN #general; alice PRIVMSG → bob sees it
//      within ~1s. Sender does NOT receive an echo.
//   2. MCP-side append: append a {from:"coord-dev", text:"hello from MCP"}
//      entry directly into rooms/design.jsonl with alice + bob both JOINed
//      to #design — both IRC clients should receive a PRIVMSG line within
//      ~1s. This is the cross-bridge test.
//   3. TOPIC set + race: alice sets topic on #design (succeeds), then we
//      bump topicVersion in the file behind alice's back and have her set
//      topic again — expect rejection NOTICE.
//   4. DM to a non-connected nick lands in inbox/<nick>.jsonl.
//   5. LIST shows #general and #design with member counts + topics.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";

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
    if (process.env.VERBOSE) process.stderr.write(`[server stderr]\n${stderr}\n`);
  }
}

class IrcClient {
  constructor() {
    this.sock = null;
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
  async register(nick) {
    this.write("CAP LS 302");
    this.write("NICK " + nick);
    this.write("USER " + nick + " 0 * :" + nick);
    this.write("CAP END");
    await this.waitFor((l) => l.includes(" 422 "), 1000);
  }
  async waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.lines.some(predicate)) return true;
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

function dumpLines(label, c) {
  process.stdout.write(`--- ${label} ---\n`);
  for (const l of c.lines) process.stdout.write("  " + l + "\n");
}

function newId() {
  return randomBytes(8).toString("hex");
}

async function scenario1(coordDir) {
  process.stdout.write("\n[scenario 1] two-client PRIVMSG in #general\n");
  const alice = new IrcClient();
  const bob = new IrcClient();
  await alice.connect();
  await bob.connect();
  await alice.register("alice");
  await bob.register("bob");
  alice.write("JOIN #general");
  bob.write("JOIN #general");
  await alice.waitFor((l) => l.includes(" 366 ") && l.includes("#general"), 1000);
  await bob.waitFor((l) => l.includes(" 366 ") && l.includes("#general"), 1000);
  // Clear pre-PRIVMSG capture
  const bobBaseLen = bob.lines.length;
  const aliceBaseLen = alice.lines.length;
  alice.write("PRIVMSG #general :hi bob from alice");
  // Bob should see it (within ~1s of poller tick).
  const got = await bob.waitFor(
    (l) => l.includes("PRIVMSG #general") && l.includes("hi bob from alice"),
    2000,
  );
  process.stdout.write(`  bob received PRIVMSG: ${got}\n`);
  // Alice should NOT see her own message echoed.
  await sleep(800);
  const aliceEcho = alice.lines
    .slice(aliceBaseLen)
    .some((l) => l.includes("PRIVMSG #general") && l.includes("hi bob from alice"));
  process.stdout.write(`  alice echo-suppressed: ${!aliceEcho}\n`);
  process.stdout.write(
    `  new bob lines after PRIVMSG: ${JSON.stringify(bob.lines.slice(bobBaseLen))}\n`,
  );
  alice.close();
  bob.close();
  await sleep(200);
}

async function scenario2(coordDir) {
  process.stdout.write("\n[scenario 2] cross-bridge: MCP-style append delivers to IRC\n");
  const alice = new IrcClient();
  const carol = new IrcClient();
  await alice.connect();
  await carol.connect();
  await alice.register("alice");
  await carol.register("carol");
  alice.write("JOIN #design");
  carol.write("JOIN #design");
  await alice.waitFor((l) => l.includes(" 366 ") && l.includes("#design"), 1000);
  await carol.waitFor((l) => l.includes(" 366 ") && l.includes("#design"), 1000);

  // Simulate MCP-side appending directly to rooms/design.jsonl
  const file = path.join(coordDir, "rooms", "design.jsonl");
  const entry = {
    id: newId(),
    ts: Date.now(),
    from: "coord-dev",
    room: "design",
    text: "hello from MCP",
  };
  const aliceBase = alice.lines.length;
  const carolBase = carol.lines.length;
  appendFileSync(file, JSON.stringify(entry) + "\n");

  const aliceGot = await alice.waitFor(
    (l) => l.includes("PRIVMSG #design") && l.includes("hello from MCP") && l.includes("coord-dev"),
    2000,
  );
  const carolGot = await carol.waitFor(
    (l) => l.includes("PRIVMSG #design") && l.includes("hello from MCP") && l.includes("coord-dev"),
    2000,
  );
  process.stdout.write(`  alice received cross-bridge: ${aliceGot}\n`);
  process.stdout.write(`  carol received cross-bridge: ${carolGot}\n`);
  process.stdout.write(
    `  alice new lines: ${JSON.stringify(alice.lines.slice(aliceBase))}\n`,
  );
  process.stdout.write(
    `  carol new lines: ${JSON.stringify(carol.lines.slice(carolBase))}\n`,
  );

  alice.close();
  carol.close();
  await sleep(200);
}

async function scenario3(coordDir) {
  process.stdout.write("\n[scenario 3] TOPIC set + race rejection\n");
  const alice = new IrcClient();
  await alice.connect();
  await alice.register("alice");
  alice.write("JOIN #race");
  await alice.waitFor((l) => l.includes(" 366 ") && l.includes("#race"), 1000);
  alice.write("TOPIC #race :first topic");
  await sleep(300);
  // bump topicVersion behind alice's back to simulate a racing writer.
  const stateFile = path.join(coordDir, "rooms", "race.json");
  const st = JSON.parse(readFileSync(stateFile, "utf8"));
  st.topicVersion += 1;
  st.topicSetBy = "phantom";
  writeFileSync(stateFile, JSON.stringify(st, null, 2));
  const base = alice.lines.length;
  alice.write("TOPIC #race :second topic");
  await sleep(300);
  const got = alice.lines.slice(base);
  const rejected = got.some(
    (l) => l.includes("NOTICE") && l.includes("rejected") && l.includes("phantom"),
  );
  process.stdout.write(`  rejection NOTICE seen: ${rejected}\n`);
  process.stdout.write(`  lines after second TOPIC: ${JSON.stringify(got)}\n`);
  alice.close();
  await sleep(200);
}

async function scenario4(coordDir) {
  process.stdout.write("\n[scenario 4] DM to non-connected nick lands in inbox\n");
  const alice = new IrcClient();
  await alice.connect();
  await alice.register("alice");
  alice.write("PRIVMSG agent-pa :hi from alice");
  await sleep(300);
  const file = path.join(coordDir, "inbox", "agent-pa.jsonl");
  const exists = existsSync(file);
  let content = exists ? readFileSync(file, "utf8") : "";
  process.stdout.write(`  inbox file exists: ${exists}\n`);
  process.stdout.write(`  inbox contents: ${content.trim()}\n`);
  alice.close();
  await sleep(200);
}

async function scenario5(coordDir) {
  process.stdout.write("\n[scenario 5] LIST shows both channels\n");
  const alice = new IrcClient();
  await alice.connect();
  await alice.register("alice");
  alice.write("LIST");
  await alice.waitFor((l) => l.includes(" 323 "), 1000);
  const listLines = alice.lines.filter((l) => l.includes(" 322 ") || l.includes(" 321 ") || l.includes(" 323 "));
  for (const l of listLines) process.stdout.write("  " + l + "\n");
  alice.close();
  await sleep(200);
}

async function main() {
  const coordDir = mkdtempSync(path.join(tmpdir(), "coord-irc-task3-"));
  process.stdout.write(`coordDir=${coordDir}\n`);
  try {
    await withServer(coordDir, async () => {
      await scenario1(coordDir);
      await scenario2(coordDir);
      await scenario3(coordDir);
      await scenario4(coordDir);
      await scenario5(coordDir);
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
