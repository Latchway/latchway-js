import { describe, expect, it } from "vitest";

import { readBoundedJSON } from "../src/json.js";

describe("bounded strict JSON", () => {
  it("accepts ordinary JSON at the configured byte limit", async () => {
    const body = `{"value":"${"a".repeat(46)}"}`;
    expect(new TextEncoder().encode(body)).toHaveLength(58);
    await expect(readBoundedJSON(new Response(body), 58)).resolves.toEqual({ value: "a".repeat(46) });
  });

  it("rejects duplicate members at every depth, including escaped aliases", async () => {
    for (const body of [
      "{\"code\":1,\"code\":2}",
      "{\"outer\":{\"code\":1,\"code\":2}}",
      "[{\"code\":1,\"\\u0063ode\":2}]",
    ]) {
      await expect(readBoundedJSON(new Response(body))).rejects.toThrow("duplicate object member");
    }
  });

  it("rejects oversized, invalid UTF-8, malformed, and excessively nested bodies", async () => {
    await expect(readBoundedJSON(new Response("12345"), 4)).rejects.toThrow("safety limit");
    await expect(readBoundedJSON(new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]))))
      .rejects.toThrow();
    await expect(readBoundedJSON(new Response("{\"value\":01}"))).rejects.toThrow("malformed");
    const nested = `${"[".repeat(65)}null${"]".repeat(65)}`;
    await expect(readBoundedJSON(new Response(nested))).rejects.toThrow("nesting limit");
  });

  it("does not wait for the untouched branch when a cloned body is oversized", async () => {
    const original = new Response("x".repeat(65_537));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = Promise.race([
        readBoundedJSON(original.clone()),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error("parser cancellation timed out")); }, 250);
        }),
      ]);
      await expect(bounded).rejects.toThrow("safety limit");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await original.body?.cancel();
    }
  });
});
