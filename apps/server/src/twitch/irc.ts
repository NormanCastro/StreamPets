/** Un mensaje IRC ya separado en sus partes (formato de Twitch: etiquetas IRCv3 + prefijo + comando + parámetros). */
export interface IrcMessage {
  tags: ReadonlyMap<string, string>;
  prefix: string | undefined;
  command: string;
  /** Parámetros; el último es el texto final (lo que va tras " :"), si lo hay. */
  params: string[];
}

/** Valores de etiquetas IRCv3: `\:` `\s` `\\` `\r` `\n` son escapes. */
function unescapeTag(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    i++;
    const n = value[i];
    if (n === undefined) break; // barra final suelta: se descarta
    out += n === ":" ? ";" : n === "s" ? " " : n === "r" ? "\r" : n === "n" ? "\n" : n;
  }
  return out;
}

export function parseIrcLine(rawLine: string): IrcMessage | undefined {
  let line = rawLine.replace(/[\r\n]+$/, "");
  if (line.length === 0) return undefined;

  const tags = new Map<string, string>();
  if (line.startsWith("@")) {
    const end = line.indexOf(" ");
    if (end === -1) return undefined;
    for (const part of line.slice(1, end).split(";")) {
      if (part.length === 0) continue;
      const eq = part.indexOf("=");
      if (eq === -1) tags.set(part, "");
      else tags.set(part.slice(0, eq), unescapeTag(part.slice(eq + 1)));
    }
    line = line.slice(end + 1).replace(/^ +/, "");
  }

  let prefix: string | undefined;
  if (line.startsWith(":")) {
    const end = line.indexOf(" ");
    if (end === -1) return undefined;
    prefix = line.slice(1, end);
    line = line.slice(end + 1).replace(/^ +/, "");
  }

  const params: string[] = [];
  const trailingAt = line.indexOf(" :");
  let head = line;
  let trailing: string | undefined;
  if (trailingAt !== -1) {
    head = line.slice(0, trailingAt);
    trailing = line.slice(trailingAt + 2);
  }
  const words = head.split(" ").filter((w) => w.length > 0);
  const command = words.shift();
  if (!command) return undefined;
  params.push(...words);
  if (trailing !== undefined) params.push(trailing);
  return { tags, prefix, command: command.toUpperCase(), params };
}

/** Lo que el sistema necesita saber de un mensaje de chat. El texto del mensaje no se conserva. */
export interface TwitchChatMessage {
  userId: string;
  login: string;
  displayName: string;
  isSubscriber: boolean;
}

/** Insignias que cuentan como suscriptor. "founder" es la de los primeros suscriptores. */
const SUBSCRIBER_BADGES = new Set(["subscriber", "founder"]);

/** Convierte un PRIVMSG en datos de chat. Devuelve undefined si no es un mensaje de usuario válido. */
export function toChatMessage(msg: IrcMessage): TwitchChatMessage | undefined {
  if (msg.command !== "PRIVMSG") return undefined;
  if (!msg.params[0]?.startsWith("#")) return undefined;

  const userId = msg.tags.get("user-id") ?? "";
  if (!/^\d{1,20}$/.test(userId)) return undefined;

  // El login viene en el prefijo: "login!login@login.tmi.twitch.tv".
  const bang = msg.prefix?.indexOf("!") ?? -1;
  const login = bang > 0 ? (msg.prefix as string).slice(0, bang).toLowerCase() : "";
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return undefined;

  const displayName = (msg.tags.get("display-name") ?? "").trim() || login;
  const badges = (msg.tags.get("badges") ?? "").split(",").map((b) => b.split("/")[0] ?? "");
  const isSubscriber = badges.some((b) => SUBSCRIBER_BADGES.has(b));
  return { userId, login, displayName, isSubscriber };
}
