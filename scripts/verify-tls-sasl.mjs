#!/usr/bin/env node
// Verification for task 5 (TLS + SASL PLAIN).

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const SERVER = path.resolve(new URL("../dist/server.js", import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function generateCert(dir) {
  mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const r = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath, "-out", certPath,
      "-days", "365", "-nodes",
      "-subj", "/CN=localhost",
    ],
    { stdio: "pipe" },
  );
  if (r.status !== 0) {
    throw new Error("openssl failed: " + r.stderr.toString());
  }
  return { certPath, keyPath };
}

async function startServer({ coordDir, extraArgs = [], expectFail = false }) {
  const child = spawn(process.execPath, [SERVER, ...extraArgs], {
    env: { ...process.env, AGENT_COORD_DIR: coordDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString()));
  if (expectFail) {
    return new Promise((res) => {
      child.on("exit", (code) => res({ child, code, stderr }));
    });
  }
  await new Promise((res) => {
    const check = () => {
      if (stderr.includes("listening on")) res();
      else setTimeout(check, 30);
    };
    check();
  });
  return { child, stderr };
}

function makeLineReader(socket) {
  const state = { lines: [], buf: "", closed: false };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    state.buf += chunk;
    let nl;
    while ((nl = state.buf.indexOf("\n")) !== -1) {
      let line = state.buf.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      state.buf = state.buf.slice(nl + 1);
      if (line.length > 0) state.lines.push(line);
    }
  });
  socket.on("close", () => (state.closed = true));
  socket.on("error", () => {}); // server-initiated close on shutdown is fine
  return state;
}

async function waitFor(state, predicate, timeoutMs, fromIdx = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.lines.slice(fromIdx).some(predicate)) return true;
    await sleep(40);
  }
  return false;
}

function saslPlainBlob(authcid, password, authzid = "") {
  const buf = Buffer.concat([
    Buffer.from(authzid),
    Buffer.from([0]),
    Buffer.from(authcid),
    Buffer.from([0]),
    Buffer.from(password),
  ]);
  return buf.toString("base64");
}

async function run() {
  const coordDir = mkdtempSync(path.join(tmpdir(), "coord-irc-task5-"));
  process.stdout.write(`coordDir=${coordDir}\n`);
  const tlsDir = path.join(coordDir, "tls");
  const { certPath, keyPath } = generateCert(tlsDir);
  writeFileSync(path.join(coordDir, "sasl-users.json"), JSON.stringify({ alice: "hunter2" }, null, 2));
  chmodSync(path.join(coordDir, "sasl-users.json"), 0o600);

  // ---- scenario 1+2: TLS handshake reaches welcome numerics ----
  {
    process.stdout.write("\n[scenario 1] TLS welcome numerics over node tls.connect\n");
    const { child, stderr } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    process.stdout.write(`  startup stderr: ${stderr.replace(/\n/g, " | ")}\n`);
    const sock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
    await new Promise((r) => sock.once("secureConnect", r));
    const state = makeLineReader(sock);
    sock.write("CAP LS 302\r\n");
    sock.write("NICK tlsnick\r\n");
    sock.write("USER tlsnick 0 * :TLS Nick\r\n");
    sock.write("CAP END\r\n");
    await waitFor(state, (l) => l.includes(" 422 "), 1500);
    for (const l of state.lines) process.stdout.write("  " + l + "\n");
    sock.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  // ---- scenario 3: SASL happy path ----
  {
    process.stdout.write("\n[scenario 3] SASL PLAIN success → 900 + 903 + welcome\n");
    const { child } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    const sock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
    await new Promise((r) => sock.once("secureConnect", r));
    const state = makeLineReader(sock);
    sock.write("CAP LS 302\r\n");
    sock.write("CAP REQ :sasl\r\n");
    await waitFor(state, (l) => l.includes(" CAP ") && l.includes("ACK"), 1500);
    sock.write("AUTHENTICATE PLAIN\r\n");
    await waitFor(state, (l) => l.startsWith("AUTHENTICATE +"), 1500);
    sock.write("AUTHENTICATE " + saslPlainBlob("alice", "hunter2") + "\r\n");
    await waitFor(state, (l) => l.includes(" 903 "), 1500);
    sock.write("NICK alice\r\n");
    sock.write("USER alice 0 * :Alice\r\n");
    sock.write("CAP END\r\n");
    await waitFor(state, (l) => l.includes(" 422 "), 1500);
    for (const l of state.lines) process.stdout.write("  " + l + "\n");
    sock.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  // ---- scenario 4: SASL failure (wrong password) ----
  {
    process.stdout.write("\n[scenario 4] SASL PLAIN wrong password → 904, conn stays open\n");
    const { child } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    const sock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
    await new Promise((r) => sock.once("secureConnect", r));
    const state = makeLineReader(sock);
    sock.write("CAP LS 302\r\n");
    sock.write("CAP REQ :sasl\r\n");
    await waitFor(state, (l) => l.includes("ACK"), 1500);
    sock.write("AUTHENTICATE PLAIN\r\n");
    await waitFor(state, (l) => l.startsWith("AUTHENTICATE +"), 1500);
    sock.write("AUTHENTICATE " + saslPlainBlob("alice", "wrong") + "\r\n");
    await waitFor(state, (l) => l.includes(" 904 "), 1500);
    process.stdout.write(`  conn closed after 904? ${state.closed}\n`);
    for (const l of state.lines) process.stdout.write("  " + l + "\n");
    sock.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  // ---- scenario 5: SASL abort ----
  {
    process.stdout.write("\n[scenario 5] AUTHENTICATE * → 906, then unauth path\n");
    const { child } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    const sock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
    await new Promise((r) => sock.once("secureConnect", r));
    const state = makeLineReader(sock);
    sock.write("CAP LS 302\r\n");
    sock.write("CAP REQ :sasl\r\n");
    await waitFor(state, (l) => l.includes("ACK"), 1500);
    sock.write("AUTHENTICATE PLAIN\r\n");
    await waitFor(state, (l) => l.startsWith("AUTHENTICATE +"), 1500);
    sock.write("AUTHENTICATE *\r\n");
    await waitFor(state, (l) => l.includes(" 906 "), 1500);
    // Without sasl-users.json, since SASL aborted, server-pass should apply.
    // But this coordDir HAS sasl-users.json and no server-pass — so unauth path
    // should still complete.
    sock.write("NICK noauth\r\n");
    sock.write("USER noauth 0 * :NoAuth\r\n");
    sock.write("CAP END\r\n");
    await waitFor(state, (l) => l.includes(" 422 "), 1500);
    for (const l of state.lines) process.stdout.write("  " + l + "\n");
    sock.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  // ---- scenario 6: NICK mismatch post-SASL ----
  {
    process.stdout.write("\n[scenario 6] SASL=alice then NICK bob → 902 reject\n");
    const { child } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    const sock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
    await new Promise((r) => sock.once("secureConnect", r));
    const state = makeLineReader(sock);
    sock.write("CAP LS 302\r\n");
    sock.write("CAP REQ :sasl\r\n");
    await waitFor(state, (l) => l.includes("ACK"), 1500);
    sock.write("AUTHENTICATE PLAIN\r\n");
    await waitFor(state, (l) => l.startsWith("AUTHENTICATE +"), 1500);
    sock.write("AUTHENTICATE " + saslPlainBlob("alice", "hunter2") + "\r\n");
    await waitFor(state, (l) => l.includes(" 903 "), 1500);
    sock.write("NICK bob\r\n"); // should be rejected
    await sleep(200);
    sock.write("NICK alice\r\n"); // should succeed
    sock.write("USER alice 0 * :Alice\r\n");
    sock.write("CAP END\r\n");
    await waitFor(state, (l) => l.includes(" 422 "), 1500);
    for (const l of state.lines) process.stdout.write("  " + l + "\n");
    sock.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  // ---- scenario 7: non-loopback warning ----
  {
    process.stdout.write("\n[scenario 7] --bind 0.0.0.0 without --tls-port → warning\n");
    const { child, stderr } = await startServer({
      coordDir,
      extraArgs: ["--bind", "0.0.0.0", "--port", "6677"],
    });
    process.stdout.write(stderr.replace(/^/gm, "  "));
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  // ---- scenario 8: missing cert ----
  {
    process.stdout.write("\n[scenario 8] --tls-port without cert files → fatal\n");
    const { code, stderr } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", "/nonexistent/cert.pem", "--tls-key", "/nonexistent/key.pem"],
      expectFail: true,
    });
    process.stdout.write(`  exit code: ${code}\n`);
    process.stdout.write(stderr.replace(/^/gm, "  "));
  }

  // ---- scenario 9: SASL replaces PASS ----
  {
    process.stdout.write("\n[scenario 9] server-pass + sasl-users.json coexist\n");
    writeFileSync(path.join(coordDir, "server-pass"), "secret");
    const { child } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    // 9a: SASL alice (no PASS) → welcome
    {
      const sock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
      await new Promise((r) => sock.once("secureConnect", r));
      const state = makeLineReader(sock);
      sock.write("CAP LS 302\r\n");
      sock.write("CAP REQ :sasl\r\n");
      await waitFor(state, (l) => l.includes("ACK"), 1500);
      sock.write("AUTHENTICATE PLAIN\r\n");
      await waitFor(state, (l) => l.startsWith("AUTHENTICATE +"), 1500);
      sock.write("AUTHENTICATE " + saslPlainBlob("alice", "hunter2") + "\r\n");
      sock.write("NICK alice\r\n");
      sock.write("USER alice 0 * :Alice\r\n");
      sock.write("CAP END\r\n");
      const reached = await waitFor(state, (l) => l.includes(" 422 "), 1500);
      process.stdout.write(`  9a: SASL alice (no PASS) reached 422: ${reached}\n`);
      if (!reached) {
        process.stdout.write("  9a debug — alice received lines:\n");
        for (const l of state.lines) process.stdout.write("    " + l + "\n");
      }
      sock.end();
      await sleep(150);
    }
    // 9b: PASS without SASL → welcome
    {
      const sock = netConnect({ host: "127.0.0.1", port: 6667 });
      await new Promise((r) => sock.once("connect", r));
      const state = makeLineReader(sock);
      sock.write("PASS secret\r\n");
      sock.write("CAP LS 302\r\n");
      sock.write("NICK bob\r\n");
      sock.write("USER bob 0 * :Bob\r\n");
      sock.write("CAP END\r\n");
      const reached = await waitFor(state, (l) => l.includes(" 422 "), 1500);
      process.stdout.write(`  9b: PASS only reached 422: ${reached}\n`);
      sock.end();
      await sleep(150);
    }
    // 9c: neither → 464
    {
      const sock = netConnect({ host: "127.0.0.1", port: 6667 });
      await new Promise((r) => sock.once("connect", r));
      const state = makeLineReader(sock);
      sock.write("CAP LS 302\r\n");
      sock.write("NICK carol\r\n");
      sock.write("USER carol 0 * :Carol\r\n");
      sock.write("CAP END\r\n");
      const got464 = await waitFor(state, (l) => l.includes(" 464 "), 1500);
      process.stdout.write(`  9c: no SASL no PASS → 464: ${got464}\n`);
      sock.end();
    }
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    // restore for scenario 10
    rmSync(path.join(coordDir, "server-pass"));
  }

  // ---- scenario 10: plain + TLS clients coexist + PRIVMSG cross-listener ----
  {
    process.stdout.write("\n[scenario 10] plain client + TLS client in same #test channel\n");
    const { child } = await startServer({
      coordDir,
      extraArgs: ["--tls-port", "6697", "--tls-cert", certPath, "--tls-key", keyPath],
    });
    // plain alice (using SASL since file exists — bypasses any pass we may have set)
    const plainSock = netConnect({ host: "127.0.0.1", port: 6667 });
    await new Promise((r) => plainSock.once("connect", r));
    const plainState = makeLineReader(plainSock);
    plainSock.write("CAP LS 302\r\n");
    plainSock.write("CAP REQ :sasl\r\n");
    await waitFor(plainState, (l) => l.includes("ACK"), 1500);
    plainSock.write("AUTHENTICATE PLAIN\r\n");
    await waitFor(plainState, (l) => l.startsWith("AUTHENTICATE +"), 1500);
    plainSock.write("AUTHENTICATE " + saslPlainBlob("alice", "hunter2") + "\r\n");
    plainSock.write("NICK alice\r\n");
    plainSock.write("USER alice 0 * :Alice\r\n");
    plainSock.write("CAP END\r\n");
    await waitFor(plainState, (l) => l.includes(" 422 "), 1500);

    // tls bob (no SASL needed — connect plain registration without SASL fails because sasl file exists & no PASS... wait that's wrong)
    // Actually: SASL is OPTIONAL. Without SASL and without server-pass, registration succeeds.
    // Since this scenario has no server-pass file, the no-SASL path works.
    const tlsSock = tlsConnect({ host: "127.0.0.1", port: 6697, rejectUnauthorized: false });
    await new Promise((r) => tlsSock.once("secureConnect", r));
    const tlsState = makeLineReader(tlsSock);
    tlsSock.write("CAP LS 302\r\n");
    tlsSock.write("NICK bob\r\n");
    tlsSock.write("USER bob 0 * :Bob\r\n");
    tlsSock.write("CAP END\r\n");
    await waitFor(tlsState, (l) => l.includes(" 422 "), 1500);

    plainSock.write("JOIN #test\r\n");
    tlsSock.write("JOIN #test\r\n");
    await waitFor(plainState, (l) => l.includes(" 366 ") && l.includes("#test"), 1500);
    await waitFor(tlsState, (l) => l.includes(" 366 ") && l.includes("#test"), 1500);

    const baseTls = tlsState.lines.length;
    const basePlain = plainState.lines.length;
    plainSock.write("PRIVMSG #test :hello from plain alice\r\n");
    const tlsGot = await waitFor(
      tlsState,
      (l) => l.includes("PRIVMSG #test") && l.includes("hello from plain alice"),
      2000,
      baseTls,
    );
    tlsSock.write("PRIVMSG #test :hi back from tls bob\r\n");
    const plainGot = await waitFor(
      plainState,
      (l) => l.includes("PRIVMSG #test") && l.includes("hi back from tls bob"),
      2000,
      basePlain,
    );
    process.stdout.write(`  tls bob received plain alice's PRIVMSG: ${tlsGot}\n`);
    process.stdout.write(`  plain alice received tls bob's PRIVMSG: ${plainGot}\n`);

    plainSock.end();
    tlsSock.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }

  rmSync(coordDir, { recursive: true, force: true });
}

run().catch((e) => {
  process.stderr.write(e.stack + "\n");
  process.exit(1);
});
