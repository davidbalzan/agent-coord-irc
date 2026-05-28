#!/usr/bin/env node
import { createServer } from "node:net";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { drainBuffer } from "./protocol.js";
import { Client, type ServerContext } from "./client.js";
import { Hub } from "./hub.js";
import { ensureChannel } from "./channels.js";

const HOST = "127.0.0.1";
const PORT = 6667;

async function loadVersion(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server.js → ../package.json ; src/server.ts (tsx) → ../package.json
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

async function main(): Promise<void> {
  const version = await loadVersion();
  const ctx: ServerContext = {
    hostname: hostname(),
    version,
    startedAtIso: new Date().toISOString(),
    clientsByNick: new Map(),
    hub: new Hub(),
  };
  await ensureChannel("#general");

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    const client = new Client(socket, ctx);

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
  });

  server.listen(PORT, HOST, () => {
    process.stderr.write(`agent-coord-irc listening on ${HOST}:${PORT}\n`);
  });

  const shutdown = (sig: string) => {
    process.stderr.write(`received ${sig}, shutting down\n`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
