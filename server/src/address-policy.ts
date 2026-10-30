import net from "node:net";

export interface AddressPolicy {
  allowLan: boolean;
  allowLoopback: boolean;
}

const v4Refusal = (address: string, policy: AddressPolicy): string | undefined => {
  const [a, b, c, d] = address.split(".").map(Number);
  if (a === 127) return policy.allowLoopback ? undefined : "loopback is not enabled";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return policy.allowLan ? undefined : "the LAN is not enabled";
  }
  if (a === 0) return "an unspecified range";
  if (a === 169 && b === 254) return "a link-local range";
  if (a === 100 && b >= 64 && b <= 127) return "a CGNAT range";
  if (a === 192 && b === 0 && c === 0) return "a reserved range";
  if (a === 192 && b === 0 && c === 2) return "a documentation range";
  if (a === 192 && b === 88 && c === 99) return "a reserved range";
  if (a === 198 && (b === 18 || b === 19)) return "a benchmark range";
  if (a === 198 && b === 51 && c === 100) return "a documentation range";
  if (a === 203 && b === 0 && c === 113) return "a documentation range";
  if (a === 168 && b === 63 && c === 129 && d === 16) return "a platform range";
  if (a >= 224) return "a multicast or reserved range";
  return undefined;
};

const parseIPv6 = (input: string): Uint8Array | undefined => {
  let text = input;
  let embedded: number[] | undefined;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const tail = text.slice(lastColon + 1).split(".").map(Number);
    if (tail.length !== 4 || tail.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    embedded = tail;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : undefined;
  const groups = tail === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[index])) return undefined;
    const value = parseInt(groups[index], 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  if (embedded) bytes.set(embedded, 12);
  return bytes;
};

const v6Refusal = (address: string, policy: AddressPolicy): string | undefined => {
  const bytes = parseIPv6(address);
  if (!bytes) return "not a literal address";
  const firstTenZero = bytes.subarray(0, 10).every((value) => value === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return v4Refusal(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`, policy);
  }
  if (bytes.every((value) => value === 0)) return "an unspecified address";
  if (bytes.subarray(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return policy.allowLoopback ? undefined : "loopback is not enabled";
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "a link-local range";
  if (bytes[0] === 0xff) return "a multicast range";
  if ((bytes[0] & 0xfe) === 0xfc) return policy.allowLan ? undefined : "the LAN is not enabled";
  if ((bytes[0] & 0xe0) === 0x20) {
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] & 0xfe) === 0x00) return "a special-purpose range";
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return "a documentation range";
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return "a transition range";
    if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return "a documentation range";
    return undefined;
  }
  return "a special-purpose range";
};

/** Why a literal address may not be reached under this policy, or undefined when it may.
 *  A hostname is not a literal address and is refused as such. */
export function addressRefusal(address: string, policy: AddressPolicy): string | undefined {
  if (typeof address !== "string" || address.includes("%")) return "a zone identifier";
  const bare = address.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return v4Refusal(bare, policy);
  if (net.isIPv6(bare)) return v6Refusal(bare, policy);
  return "not a literal address";
}
