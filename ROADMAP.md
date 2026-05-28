# Roadmap — agent-coord-irc

Embedded IRC server bolt-on for [agent-coord-mcp](https://github.com/davidbalzan/agent-coord-mcp). Exposes the local file-backed bus (`~/agent-coord/`) over the network so humans on any machine can join with their existing IRC client (weechat, irssi, HexChat, web). Not a substitute for MCP — remote *agents* should use the MCP HTTP transport in agent-coord-mcp Phase 6.

The JSONL files under `~/agent-coord/` remain the source of truth. This server is a view onto them.

## Design constraints (carried over from agent-coord-mcp Phase 5)

- Single canonical instance. No server-to-server federation.
- TCP listener on `127.0.0.1` by default. LAN bind / TLS opt-in only.
- Default-deny network exposure — `--bind` other than loopback prints a warning.
- Verbs only as we need them: `PRIVMSG`, `JOIN`, `PART`, `NICK`, `TOPIC`, `NAMES`, `LIST`, `MOTD`, `WHO`, `WHOIS`, `PING`, `PASS`, `QUIT`, `CAP LS/REQ/END`, `CHATHISTORY`.
- IRCv3 `message-tags` for structured payload pass-through; `CHATHISTORY` for replay.
- Optimistic concurrency on TOPIC / MOTD / membership mutations (mirrors the MCP store).
- No services pseudo-users (`NickServ`, `ChanServ`) — the registry already plays that role.

## Milestones

### 1. Scaffold — ✅ shipped (commit `3afb06e`)

Buildable Node+TS project mirroring agent-coord-mcp conventions. TCP listener on `127.0.0.1:6667` writes a hello string on connect. No protocol yet.

### 2. Connection registration + auth — 🚧 in flight

- IRC line parser (RFC 1459/2812, IRCv3 tag-aware).
- `PASS` (optional, gated on `~/agent-coord/server-pass`), `NICK`, `USER`, `CAP LS/REQ/END` handshake.
- Nick validation + collision check against live IRC clients and `agents.json`.
- Welcome numerics: `001 002 003 004 005 422`.
- `PING`/`PONG` keepalive (60s interval, 30s timeout).
- Registry integration: write `{ agentId, role, registeredAt, lastHeartbeat, capabilities: ["irc-attached"] }` to `agents.json` on register, heartbeat every 30s, remove on QUIT/close.

### 3. Channels — 📝 next

- `JOIN` / `PART` / `NAMES` / `LIST` / `TOPIC`.
- Membership stored in the same files agent-coord-mcp uses; topic carries a `version` for optimistic concurrency.
- `PRIVMSG #room` writes to `~/agent-coord/rooms/<room>.jsonl` so local MCP agents see it.
- `PRIVMSG <nick>` writes to `~/agent-coord/inbox/<nick>.jsonl`.
- Fan-out: when MCP-side writes arrive in those files, push them to IRC clients joined to the channel.
- `WHO` / `WHOIS` map to the registry.

### 4. History (CHATHISTORY) — 📝 planned

- IRCv3 `CHATHISTORY LATEST|BEFORE|AFTER #room <ts|*> <n>` served from the JSONL files.
- No auto-replay on JOIN — clients opt in. Matches the standard, keeps the verb surface small.
- `message-tags` (`@id=...;ts=...;coord-from=...`) carried through on fan-out so structured payloads round-trip for IRCv3-aware clients.

### 5. TLS + SASL — 📝 planned

- TLS listener (`--tls --cert ... --key ...`), default bind still loopback.
- SASL `PLAIN` over TLS for per-agent credentials (Tier 2 of the auth model).
- SASL `EXTERNAL` with client certs (Tier 3) tracked but not blocking.
- README leads with the threat-model change before any non-loopback bind.

## Out of scope

- Server-to-server federation.
- IRCv3 services (`NickServ`/`ChanServ`) — replaced by the registry.
- Persistent bouncer behavior — clients reconnect themselves.
- Acting as the path for *remote agents*. They should use the MCP HTTP transport.
