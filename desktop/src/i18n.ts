export const en = {
  "connect.title": "Connect to a server",
  "connect.address": "Server address",
  "connect.addressHint": "Origin only, for example http://192.168.1.20:8090",
  "connect.connect": "Connect",
  "connect.disconnect": "Disconnect",
  "connect.probing": "Checking the server…",
  "connect.unreachable": "The server did not answer.",
  "connect.invalid": "Enter an origin with no path, for example http://192.168.1.20:8090.",
  "connect.insecure": "This address is on the public internet, so it has to be HTTPS.",
  "connect.notStatus": "The address answered, but not with this app's status.",
  "connect.version": "Server version {version}",
  "connect.restricted": "Restricted mode is on.",
  "connect.secure": "Secure mode is on.",
};

export const cs: typeof en = {
  "connect.title": "Připojení k serveru",
  "connect.address": "Adresa serveru",
  "connect.addressHint": "Jen původ, například http://192.168.1.20:8090",
  "connect.connect": "Připojit",
  "connect.disconnect": "Odpojit",
  "connect.probing": "Ověřuji server…",
  "connect.unreachable": "Server neodpověděl.",
  "connect.invalid": "Zadejte původ bez cesty, například http://192.168.1.20:8090.",
  "connect.insecure": "Tahle adresa je na veřejném internetu, takže musí být HTTPS.",
  "connect.notStatus": "Adresa odpověděla, ale ne stavem téhle aplikace.",
  "connect.version": "Verze serveru {version}",
  "connect.restricted": "Omezený režim je zapnutý.",
  "connect.secure": "Zabezpečený režim je zapnutý.",
};

export function catalogue(locale: string): typeof en {
  return locale.trim().toLowerCase().startsWith("cs") ? cs : en;
}
