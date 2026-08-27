const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64urlEncode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return output.replace(/=+$/u, "").replaceAll("+", "-").replaceAll("/", "_");
}

export function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) throw new TypeError("Invalid base64url value.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const a = alphabet.indexOf(padded[index] ?? "=");
    const b = alphabet.indexOf(padded[index + 1] ?? "=");
    const c = padded[index + 2] === "=" ? 0 : alphabet.indexOf(padded[index + 2] ?? "=");
    const d = padded[index + 3] === "=" ? 0 : alphabet.indexOf(padded[index + 3] ?? "=");
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new TypeError("Invalid base64url value.");
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((combined >>> 16) & 255);
    if (padded[index + 2] !== "=") bytes.push((combined >>> 8) & 255);
    if (padded[index + 3] !== "=") bytes.push(combined & 255);
  }
  return new Uint8Array(bytes);
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export function decodeUTF8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export function randomID(runtimeCrypto: Crypto): string {
  if (typeof runtimeCrypto.randomUUID === "function") return runtimeCrypto.randomUUID();
  return base64urlEncode(runtimeCrypto.getRandomValues(new Uint8Array(24)));
}
