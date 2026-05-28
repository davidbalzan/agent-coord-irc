import {
  channelJsonlPath,
  inboxJsonlPath,
  type ChannelMessage,
} from "./channels.js";
import { FilePoller } from "./watcher.js";
import type { Client } from "./client/index.js";

interface ChannelRuntime {
  poller: FilePoller;
  active: Set<Client>;
}

interface InboxRuntime {
  poller: FilePoller;
}

/**
 * Tracks which IRC clients are "active" in a channel (subscribed to live
 * delivery) and runs one poller per occupied channel + one per connected
 * nick's inbox. Pollers lazily start when first joiner arrives and stop
 * when the last leaves.
 */
export class Hub {
  private channels = new Map<string, ChannelRuntime>();
  private inboxes = new Map<string, InboxRuntime>();

  async addChannelClient(channel: string, client: Client): Promise<void> {
    let rt = this.channels.get(channel);
    if (!rt) {
      const poller = new FilePoller(channelJsonlPath(channel), (line) =>
        this.dispatchChannelLine(channel, line),
      );
      rt = { poller, active: new Set() };
      this.channels.set(channel, rt);
      await poller.start();
    }
    rt.active.add(client);
  }

  removeChannelClient(channel: string, client: Client): void {
    const rt = this.channels.get(channel);
    if (!rt) return;
    rt.active.delete(client);
    if (rt.active.size === 0) {
      rt.poller.stop();
      this.channels.delete(channel);
    }
  }

  activeMembers(channel: string): Client[] {
    const rt = this.channels.get(channel);
    return rt ? [...rt.active] : [];
  }

  removeClientEverywhere(client: Client): void {
    for (const [name, rt] of this.channels) {
      if (rt.active.delete(client) && rt.active.size === 0) {
        rt.poller.stop();
        this.channels.delete(name);
      }
    }
  }

  async addInboxClient(client: Client): Promise<void> {
    if (!client.nick) return;
    const key = client.nick.toLowerCase();
    if (this.inboxes.has(key)) return;
    const poller = new FilePoller(inboxJsonlPath(client.nick), (line) =>
      this.dispatchInboxLine(client, line),
    );
    this.inboxes.set(key, { poller });
    await poller.start();
  }

  removeInboxClient(nick: string): void {
    const key = nick.toLowerCase();
    const rt = this.inboxes.get(key);
    if (!rt) return;
    rt.poller.stop();
    this.inboxes.delete(key);
  }

  private dispatchChannelLine(channel: string, line: string): void {
    let entry: ChannelMessage;
    try {
      entry = JSON.parse(line) as ChannelMessage;
    } catch {
      return;
    }
    const rt = this.channels.get(channel);
    if (!rt) return;
    for (const client of rt.active) {
      if (!client.nick) continue;
      // Echo suppression: don't redeliver to the sender.
      if (entry.from === client.nick) continue;
      const prefix = `${entry.from}!${entry.from}@coord`;
      // Multi-line bodies → one PRIVMSG per line.
      for (const text of entry.text.split("\n")) {
        client.sendRaw(prefix, "PRIVMSG", [channel, text]);
      }
    }
  }

  private dispatchInboxLine(client: Client, line: string): void {
    let entry: ChannelMessage;
    try {
      entry = JSON.parse(line) as ChannelMessage;
    } catch {
      return;
    }
    if (!client.nick) return;
    if (entry.from === client.nick) return; // skip self-sent
    const prefix = `${entry.from}!${entry.from}@coord`;
    for (const text of entry.text.split("\n")) {
      client.sendRaw(prefix, "PRIVMSG", [client.nick, text]);
    }
  }
}
