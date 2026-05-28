# agent-coord-irc

Embedded IRC server bolt-on for [agent-coord-mcp](https://github.com/davidbalzan/agent-coord-mcp). It exposes the local file-backed agent-coord bus (`~/agent-coord/`) over the network using standard IRC, so humans on other machines can join the same room with their existing IRC client (weechat, irssi, HexChat, gamja, ...). See [ROADMAP.md](./ROADMAP.md) for the phased plan.

> **For humans, not agents.** Remote *agents* should use agent-coord-mcp's MCP HTTP transport (Phase 6, in agent-coord-mcp) — keeping their tool calls structured end-to-end. IRC is the right protocol for humans because the ecosystem of mature chat clients gives them great UX for free. See `ROADMAP.md` for the full reasoning.

> **It's a network service.** Default bind is `127.0.0.1` and there is no auth on the plain listener. Anything beyond loopback needs `--tls-port` plus a SASL credentials file — the server prints a loud warning if you start it on `0.0.0.0` without TLS.

> **Source of truth is still the JSONL files.** This server is a view onto `~/agent-coord/` — both directions. IRC PRIVMSGs land in `rooms/<chan>.jsonl` / `inbox/<nick>.jsonl` and MCP-side writes by local agents are pushed to IRC clients via a per-channel poller within ~500ms.

## Install

```sh
git clone https://github.com/davidbalzan/agent-coord-irc.git
cd agent-coord-irc
npm install            # runs `npm run build` via `prepare`
```

The built entrypoint is `dist/server.js` (also exposed as the `agent-coord-irc` bin once installed).

## Quickstart — plain localhost

```sh
node dist/server.js
# agent-coord-irc listening on 127.0.0.1:6667 (plain)
```

Then point any IRC client at it:

```
# weechat
/server add coord localhost/6667 -nopassword
/connect coord
/join #general
```

`tail -f ~/agent-coord/rooms/general.jsonl` to spectate from another terminal — IRC PRIVMSGs and MCP-side `send_message` calls interleave in the same file.

## Quickstart — TLS + SASL for non-loopback exposure

```sh
# 1. Generate a self-signed cert (or use a real one)
mkdir -p ~/agent-coord/tls
openssl req -x509 -newkey rsa:2048 \
  -keyout ~/agent-coord/tls/key.pem -out ~/agent-coord/tls/cert.pem \
  -days 365 -nodes -subj "/CN=localhost"

# 2. Create SASL credentials (plaintext for now; bcrypt is a follow-up)
cat > ~/agent-coord/sasl-users.json <<'EOF'
{
  "alice": "hunter2",
  "bob":   "correcthorse"
}
EOF
chmod 600 ~/agent-coord/sasl-users.json

# 3. Start with both listeners
node dist/server.js --bind 0.0.0.0 --tls-port 6697
```

Client side:

```
# weechat
/server add coord-tls your.host/6697 -ssl -ssl_verify=off
/set irc.server.coord-tls.sasl_username alice
/set irc.server.coord-tls.sasl_password hunter2
/set irc.server.coord-tls.sasl_mechanism plain
/connect coord-tls
/join #general
```

Successful SASL emits `900 RPL_LOGGEDIN` + `903 RPL_SASLSUCCESS` before the usual `001`–`005`/`422` welcome.

## CLI flags

```
agent-coord-irc [flags]

--bind <addr>       Address to bind both listeners to.   Default: 127.0.0.1
--port <n>          Plain (TCP) listener port.           Default: 6667
--tls-port <n>      TLS listener port. Opt-in.           Default: (off)
--tls-cert <path>   PEM cert for TLS listener.           Default: ~/agent-coord/tls/cert.pem
--tls-key <path>    PEM key for TLS listener.            Default: ~/agent-coord/tls/key.pem
-h, --help          Print this and exit.
```

A non-loopback `--bind` without `--tls-port` prints a multi-line warning to stderr (red on a TTY). It does not refuse to start.

## Threat model

- The plain listener has **no transport security**. Use it only on `127.0.0.1` or trusted LAN.
- The plain listener supports `PASS <token>` (`~/agent-coord/server-pass`, mode 600). Adequate for casual access on a trusted network; do not use over the public internet.
- The TLS listener supports SASL PLAIN against `~/agent-coord/sasl-users.json`. Passwords are stored plaintext in v0.1 — protect the file (chmod 600; the server warns on stderr if mode is broader). bcrypt is on the roadmap.
- If SASL succeeded on a connection, the `PASS` check is skipped — SASL is the authoritative credential.
- `nick!user@host` prefixes use the literal host `coord` (not the real remote address) — by design, to avoid leaking LAN topology.

## Supported IRC verbs

Implemented:

| Verb | Notes |
| --- | --- |
| `CAP LS / REQ / END / LIST` | Atomic ACK/NAK |
| `PASS` | Shared-secret check against `~/agent-coord/server-pass` |
| `AUTHENTICATE` | SASL PLAIN, single-chunk |
| `NICK` | `[A-Za-z][A-Za-z0-9._-]{0,31}`; case-insensitive collision with live IRC + `agents.json` |
| `USER` | Realname becomes `role` in `agents.json` |
| `QUIT` | Awaited registry cleanup |
| `PING` / `PONG` | Server-initiated PING every 60s, 30s pong timeout |
| `JOIN` / `PART` | Comma lists. Auto-creates the channel sidecar on first JOIN. |
| `PRIVMSG` | Channel + nick targets. Multi-line bodies → one PRIVMSG per line. |
| `NAMES` / `LIST` | Members are the union of currently-IRC-connected + MCP-side joiners |
| `TOPIC` | Optimistic concurrency via `topicVersion`; race-loser gets a NOTICE |
| `CHATHISTORY` | IRCv3 — `LATEST`, `BEFORE`, `AFTER`, `BETWEEN` with `*` or `timestamp=` criteria. `AROUND`/`TARGETS` return `400 :Subcommand not implemented`. |

IRCv3 capabilities advertised: `message-tags`, `server-time`, `batch`, `draft/chathistory`, plus `sasl=PLAIN` when `sasl-users.json` exists.

Out of scope for v0.x: server-to-server federation, services pseudo-users (`NickServ`/`ChanServ`), bouncer / persistent-connection semantics, modes (`+o`, `+v`, ...).

## Verified with

- `weechat` over plain and TLS, with and without SASL
- `irssi`
- `openssl s_client -connect localhost:6697 -quiet` (manual handshake)
- Scripted node TCP/TLS client (see `scripts/verify-*.mjs`)

## See also

- [agent-coord-mcp](https://github.com/davidbalzan/agent-coord-mcp) — the local-stdio MCP server this is a network bolt-on for. Local agents and the bundled `coord-chat` TUI stay on that side.
- [`ROADMAP.md`](./ROADMAP.md) — milestones (scaffold ✅, handshake ✅, channels ✅, CHATHISTORY ✅, TLS+SASL ✅).
