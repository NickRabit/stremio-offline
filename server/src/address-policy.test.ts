import assert from "node:assert/strict";
import test from "node:test";
import { addressRefusal, type AddressPolicy } from "./address-policy.js";

const strict: AddressPolicy = { allowLan: false, allowLoopback: false };
const open: AddressPolicy = { allowLan: true, allowLoopback: true };

const refusedWhenStrict = [
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "168.63.129.16",
  "224.0.0.1",
  "::1",
  "::",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:a9fe:a9fe",
  "::ffff:c0a8:1",
  "::ffff:a00:1",
  "64:ff9b::a9fe:a9fe",
  "2002:a9fe:a9fe::",
  "2001::1",
  "fec0::1",
  "fc00::1",
  "fd12::1",
  "fe80::1",
  "ff02::1",
  "2001:db8::1",
  "fe80::1%eth0",
  "localhost",
  "not-an-ip",
];

const allowedWhenStrict = ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001::1"];

test("a strict policy refuses private, mapped, transition and non-literal addresses", () => {
  for (const address of refusedWhenStrict) {
    assert.equal(typeof addressRefusal(address, strict), "string", address);
  }
  for (const address of allowedWhenStrict) {
    assert.equal(addressRefusal(address, strict), undefined, address);
  }
});

test("loopback and LAN allowances do not open link-local or metadata ranges", () => {
  for (const address of ["127.0.0.1", "::1", "192.168.1.1", "fd12::1", "::ffff:c0a8:1"]) {
    assert.equal(addressRefusal(address, open), undefined, address);
  }
  for (const address of ["169.254.169.254", "::ffff:a9fe:a9fe"]) {
    assert.equal(typeof addressRefusal(address, open), "string", address);
  }
});
