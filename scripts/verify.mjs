#!/usr/bin/env node
// End-to-end verification of the IRC handshake.
// Spawns the server with a temp AGENT_COORD_DIR, runs three scenarios:
//   1. no PASS file → registration succeeds, captures welcome numerics
//   2. PASS file present, client sends correct PASS → succeeds
//   3. PASS file present, client sends no PASS → 464 + close
// Also checks agents.json before & after disconnect.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connect } from "node:net";

const SERVER = path.resolve(new URL("../dist/server.js", import.meta.url).pathname);

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function withServer(coordDir, fn) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AGENT_COORD_DIR: coordDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString()));
  // wait for "listening" line
  const ready = new Promise((res) => {
    const onData = (b) => {
      if (b.toString().includes("listening")) {
        child.stderr.off("data", onData);
        res();
      }
    };
    child.stderr.on("data", onData);
  });
  await ready;
  try {
    return await fn();
  } finally {
    child.kill("SIGTERM");
    await new Promise((res) => child.on("exit", res));
    if (process.env.VERBOSE) process.stderr.write(`[server stderr]\n${stderr}\n`);
  }
}

function ircSession(send) {
  return new Promise((res, rej) => {
    const sock = connect(6667, "127.0.0.1");
    let buf = "";
    const lines = [];
    let closed = false;
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buf = buf.slice(nl + 1);
        lines.push(line);
      }
    });
    sock.on("close", () => {
      closed = true;
      res({ lines, closed });
    });
    sock.on("error", rej);
    sock.on("connect", async () => {
      await send(sock);
    });
    setTimeout(() => {
      if (!closed) {
        sock.end();
      }
    }, 1500);
  });
}

async function scenario1() {
  const coordDir = mkdtempSync(path.join(tmpdir(), "coord-irc-1-"));
  try {
    const result = await withServer(coordDir, async () => {
      const r = await ircSession(async (sock) => {
        sock.write("CAP LS 302\r\n");
        sock.write("NICK testnick\r\n");
        sock.write("USER testuser 0 * :Test Realname\r\n");
        sock.write("CAP END\r\n");
        await sleep(400);
        // peek agents.json while connected
        const agentsFile = path.join(coordDir, "agents.json");
        if (existsSync(agentsFile)) {
          const j = JSON.parse(readFileSync(agentsFile, "utf8"));
          process.stdout.write(`[scenario1] agents.json while connected: ${JSON.stringify(j["testnick"])}\n`);
        } else {
          process.stdout.write("[scenario1] agents.json missing while connected\n");
        }
        sock.write("QUIT :bye\r\n");
        await sleep(300);
      });
      return r;
    });
    process.stdout.write("[scenario1] server → client lines:\n");
    for (const l of result.lines) process.stdout.write("  " + l + "\n");
    // post-quit check
    const agentsFile = path.join(coordDir, "agents.json");
    const after = existsSync(agentsFile) ? JSON.parse(readFileSync(agentsFile, "utf8")) : {};
    process.stdout.write(`[scenario1] agents.json after quit: ${JSON.stringify(after)}\n`);
  } finally {
    rmSync(coordDir, { recursive: true, force: true });
  }
}

async function scenario2() {
  const coordDir = mkdtempSync(path.join(tmpdir(), "coord-irc-2-"));
  writeFileSync(path.join(coordDir, "server-pass"), "hunter2");
  try {
    const result = await withServer(coordDir, async () => {
      const r = await ircSession(async (sock) => {
        sock.write("CAP LS 302\r\n");
        sock.write("NICK testnick\r\n");
        sock.write("USER testuser 0 * :Test Realname\r\n");
        sock.write("CAP END\r\n");
        await sleep(400);
      });
      return r;
    });
    process.stdout.write("[scenario2 — pass required, none sent] server → client lines:\n");
    for (const l of result.lines) process.stdout.write("  " + l + "\n");
  } finally {
    rmSync(coordDir, { recursive: true, force: true });
  }
}

async function scenario3() {
  const coordDir = mkdtempSync(path.join(tmpdir(), "coord-irc-3-"));
  writeFileSync(path.join(coordDir, "server-pass"), "hunter2");
  try {
    const result = await withServer(coordDir, async () => {
      const r = await ircSession(async (sock) => {
        sock.write("PASS hunter2\r\n");
        sock.write("CAP LS 302\r\n");
        sock.write("NICK testnick\r\n");
        sock.write("USER testuser 0 * :Test Realname\r\n");
        sock.write("CAP END\r\n");
        await sleep(400);
        sock.write("QUIT :bye\r\n");
        await sleep(200);
      });
      return r;
    });
    process.stdout.write("[scenario3 — pass required, correct] server → client lines:\n");
    for (const l of result.lines) process.stdout.write("  " + l + "\n");
  } finally {
    rmSync(coordDir, { recursive: true, force: true });
  }
}

await scenario1();
await scenario2();
await scenario3();
