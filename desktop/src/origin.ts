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

export function httpAllowedHost(host: string): boolean {
  let name = host;
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  name = name.toLowerCase();
  if (name === "localhost") return true;
  if (name.endsWith(".local") && name !== ".local") return true;
  return isPrivateAddress(name);
}

export function httpAllowed(server: ServerOrigin): boolean {
  if (server.transport === "https") return true;
  return httpAllowedHost(server.host);
}
