export const MAX_LINE_BYTES = 512;

export interface IrcMessage {
  raw: string;
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

/**
 * Parse a single IRC line (without trailing CR/LF). Tolerates extra whitespace.
 * Tags (IRCv3) are parsed into a map but otherwise unused at this layer.
 */
export function parseLine(line: string): IrcMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};

  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    const tagBlob = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
    for (const part of tagBlob.split(";")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq === -1) tags[part] = "";
      else tags[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }

  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }

  if (rest.length === 0) return null;

  const params: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(":")) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(" ");
    if (sp === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).trimStart();
  }

  const command = params.shift();
  if (!command) return null;

  return {
    raw: line,
    tags,
    prefix,
    command: command.toUpperCase(),
    params,
  };
}

/**
 * Splits an incoming buffer into complete lines. Returns the parsed messages
 * and the residual buffer (incomplete tail).
 */
export function drainBuffer(buf: string): { messages: IrcMessage[]; rest: string } {
  const messages: IrcMessage[] = [];
  let cursor = 0;
  while (true) {
    const nl = buf.indexOf("\n", cursor);
    if (nl === -1) break;
    let line = buf.slice(cursor, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    cursor = nl + 1;
    if (line.length === 0) continue;
    // Cap line length per RFC 1459 (512 incl. CRLF).
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES - 2) {
      line = line.slice(0, MAX_LINE_BYTES - 2);
    }
    const msg = parseLine(line);
    if (msg) messages.push(msg);
  }
  return { messages, rest: buf.slice(cursor) };
}

export function formatLineWithTags(
  tags: Record<string, string>,
  prefix: string | undefined,
  command: string,
  params: string[],
): string {
  const tagParts: string[] = [];
  for (const [k, v] of Object.entries(tags)) {
    tagParts.push(v === "" ? k : `${k}=${escapeTagValue(v)}`);
  }
  const tagPrefix = tagParts.length > 0 ? "@" + tagParts.join(";") + " " : "";
  return tagPrefix + formatLine(prefix, command, params);
}

function escapeTagValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\:")
    .replace(/ /g, "\\s")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

export function formatLine(prefix: string | undefined, command: string, params: string[]): string {
  const parts: string[] = [];
  if (prefix) parts.push(`:${prefix}`);
  parts.push(command);
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const isLast = i === params.length - 1;
    if (isLast && (p.includes(" ") || p.startsWith(":") || p.length === 0)) {
      parts.push(`:${p}`);
    } else {
      parts.push(p);
    }
  }
  return parts.join(" ") + "\r\n";
}
