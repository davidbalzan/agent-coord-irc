#!/usr/bin/env node
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { drainBuffer } from "./protocol.js";
import { Client, type ServerContext } from "./client/index.js";
import { Hub } from "./hub.js";
import { ensureChannel } from "./channels.js";
import { maybeWarnSaslFileMode } from "./sasl.js";

interface Cli {
  bind: string;
  port: number;
  tlsPort: number | null;
  tlsCert: string;
  tlsKey: string;
}

function parseCli(argv: string[]): Cli {
  const tlsDir = path.join(os.homedir(), "agent-coord", "tls");
  const cli: Cli = {
    bind: "127.0.0.1",
    port: 6667,
    tlsPort: null,
    tlsCert: path.join(tlsDir, "cert.pem"),
    tlsKey: path.join(tlsDir, "key.pem"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--bind":
        cli.bind = next();
        break;
      case "--port":
        cli.port = Number(next());
        break;
      case "--tls-port":
        cli.tlsPort = Number(next());
        break;
      case "--tls-cert":
        cli.tlsCert = next();
        break;
      case "--tls-key":
        cli.tlsKey = next();
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        process.stderr.write(`unknown flag: ${a}\n`);
        printUsage();
        process.exit(2);
    }
  }
  return cli;
}

function printUsage(): void {
  const tlsDir = path.join(os.homedir(), "agent-coord", "tls");
  process.stderr.write(
    `Usage: agent-coord-irc [flags]\n` +
      `\n` +
      `  --bind <addr>       Address to bind both listeners to. Default: 127.0.0.1\n` +
      `  --port <n>          Plain (TCP) listener port.          Default: 6667\n` +
      `  --tls-port <n>      TLS listener port (opt-in).         Default: off\n` +
      `  --tls-cert <path>   PEM cert for TLS listener.          Default: ${path.join(tlsDir, "cert.pem")}\n` +
      `  --tls-key <path>    PEM key for TLS listener.           Default: ${path.join(tlsDir, "key.pem")}\n` +
      `  -h, --help          Print this and exit.\n` +
      `\n` +
      `Quickstart and threat-model notes: https://github.com/davidbalzan/agent-coord-irc#readme\n`,
  );
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "localhost" || addr === "::1";
}

async function loadVersion(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, "utf8");
      const pkg = JSON.parse(raw);
      if (pkg.name === "agent-coord-irc" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      /* try next */
    }
  }
  return "0.0.0";
}

function attachConnection(socket: Socket, ctx: ServerContext, isTls: boolean): void {
  socket.setEncoding("utf8");
  const client = new Client(socket, ctx);
  client.tls = isTls;
  ctx.allClients.add(client);

  socket.on("data", (chunk: string) => {
    client.buf += chunk;
    const { messages, rest } = drainBuffer(client.buf);
    client.buf = rest;
    void (async () => {
      for (const msg of messages) {
        try {
          await client.handle(msg);
        } catch (err) {
          process.stderr.write(`handler error: ${(err as Error).message}\n`);
        }
        if (client.closed) break;
      }
    })();
  });

  socket.on("close", () => void client.close());
  socket.on("error", () => void client.close());
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const version = await loadVersion();
  const ctx: ServerContext = {
    hostname: hostname(),
    version,
    startedAtIso: new Date().toISOString(),
    clientsByNick: new Map(),
    allClients: new Set(),
    hub: new Hub(),
  };
  await ensureChannel("#general");
  maybeWarnSaslFileMode();

  // Non-loopback warning.
  if (!isLoopback(cli.bind) && cli.tlsPort === null) {
    const isatty = (process.stderr as any).isTTY === true;
    const red = (s: string) => (isatty ? `\x1b[31m${s}\x1b[0m` : s);
    process.stderr.write(red(
      `⚠  agent-coord-irc bound to ${cli.bind}:${cli.port} with no TLS listener.\n` +
      `   Credentials and chat content travel in plaintext. Add --tls-port 6697\n` +
      `   and a cert before exposing this anywhere beyond localhost.\n`,
    ));
  }

  // Plain listener.
  const plain: Server = createServer((socket) => attachConnection(socket, ctx, false));
  plain.listen(cli.port, cli.bind, () => {
    process.stderr.write(`agent-coord-irc listening on ${cli.bind}:${cli.port} (plain)\n`);
  });

  // TLS listener.
  let tlsServer: TlsServer | null = null;
  if (cli.tlsPort !== null) {
    if (!existsSync(cli.tlsCert) || !existsSync(cli.tlsKey)) {
      process.stderr.write(
        `fatal: --tls-port set but cert/key missing.\n` +
          `  --tls-cert ${cli.tlsCert} exists=${existsSync(cli.tlsCert)}\n` +
          `  --tls-key  ${cli.tlsKey}  exists=${existsSync(cli.tlsKey)}\n` +
          `  Generate a self-signed pair with:\n` +
          `    mkdir -p $(dirname ${cli.tlsCert})\n` +
          `    openssl req -x509 -newkey rsa:2048 \\\n` +
          `      -keyout ${cli.tlsKey} -out ${cli.tlsCert} \\\n` +
          `      -days 365 -nodes -subj "/CN=localhost"\n`,
      );
      process.exit(1);
    }
    const cert = readFileSync(cli.tlsCert);
    const key = readFileSync(cli.tlsKey);
    tlsServer = createTlsServer({ cert, key }, (socket) => attachConnection(socket, ctx, true));
    tlsServer.listen(cli.tlsPort, cli.bind, () => {
      process.stderr.write(
        `agent-coord-irc listening on ${cli.bind}:${cli.tlsPort} (tls)\n`,
      );
    });
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`received ${sig}, shutting down\n`);
    // Stop accepting new connections.
    plain.close();
    tlsServer?.close();
    // Drain currently-attached clients — close() awaits registry cleanup
    // (removeAgent + sidecar member removal) so we don't leave stale state.
    const closing: Promise<void>[] = [];
    for (const client of [...ctx.allClients]) {
      closing.push(client.close("Server shutting down"));
    }
    await Promise.allSettled(closing);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
