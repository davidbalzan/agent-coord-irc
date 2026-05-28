#!/usr/bin/env node
import { createServer } from "node:net";

const HOST = "127.0.0.1";
const PORT = 6667;

const server = createServer((socket) => {
  socket.write("hello from agent-coord-irc\n");
  socket.end();
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`agent-coord-irc listening on ${HOST}:${PORT}\n`);
});
