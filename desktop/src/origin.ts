import { BlockList, isIP } from "node:net";

export type Transport = "http" | "https";

export interface ServerOrigin {
  origin: string;
  transport: Transport;
  host: string;
  port: string;
}

const privateRanges = new BlockList();
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("169.254.0.0", 16, "ipv4");
privateRanges.addSubnet("::1", 128, "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");

export function parseServerOrigin(input: string): ServerOrigin | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return { origin: url.origin, transport: url.protocol === "http:" ? "http" : "https", host: url.hostname, port: url.port };
}

const isPrivateAddress = (name: string): boolean => {
  const mapped = name.startsWith("::ffff:") ? name.slice("::ffff:".length) : null;
  const address = mapped !== null && isIP(mapped) === 4 ? mapped : name;
  const family = isIP(address);
  if (family === 4) return privateRanges.check(address, "ipv4");
  if (family === 6) return privateRanges.check(address, "ipv6");
  return false;
};

/** Plain HTTP is only `localhost` or a private address written in the URL. Every other name is refused: the lookup is not the address the socket later uses. */
export function httpAllowedHost(host: string): boolean {
  let name = host;
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  name = name.toLowerCase();
  return name === "localhost" || isPrivateAddress(name);
}

export function httpAllowed(server: ServerOrigin): boolean {
  if (server.transport === "https") return true;
  return httpAllowedHost(server.host);
}

/** One persistent session per origin. Cookies ignore the port, so two servers on the same name must not share a jar. */
export function partitionForOrigin(origin: string): string {
  return `persist:stremio-${Buffer.from(origin, "utf8").toString("base64url")}`;
}

/** A link the system browser may open. Anything else stays in the shell, which refuses it. */
export function externalBrowserUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

