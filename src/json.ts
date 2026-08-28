const DEFAULT_MAXIMUM_JSON_BYTES = 65_536;
const MAXIMUM_JSON_DEPTH = 64;

/** Reads a response body without allowing an unbounded allocation or ambiguous JSON objects. */
export async function readBoundedJSON(
  response: Response,
  maximumBytes = DEFAULT_MAXIMUM_JSON_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("The JSON response limit is invalid.");
  }

  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && /^[0-9]+$/u.test(declaredLength) &&
      Number(declaredLength) > maximumBytes) {
    cancelBody(response.body);
    throw new SyntaxError("The JSON response exceeds the safety limit.");
  }

  const reader = response.body?.getReader();
  if (reader === undefined) throw new SyntaxError("The JSON response body is missing.");
  const bytes = new Uint8Array(maximumBytes);
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > maximumBytes - size) {
        cancelReader(reader);
        throw new SyntaxError("The JSON response exceeds the safety limit.");
      }
      bytes.set(result.value, size);
      size += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  new StrictJSONScanner(text).validate();
  return JSON.parse(text) as unknown;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  // A Response clone is a tee. Awaiting cancellation of only one branch can
  // wait for an untouched application branch forever, so cancellation is
  // initiated without delaying fail-closed parsing.
  void body?.cancel().catch(() => undefined);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

class StrictJSONScanner {
  private offset = 0;

  constructor(private readonly source: string) {}

  validate(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.invalid();
  }

  private scanValue(depth: number): void {
    switch (this.source[this.offset]) {
      case "{":
        this.scanObject(depth);
        return;
      case "[":
        this.scanArray(depth);
        return;
      case "\"":
        this.scanString();
        return;
      case "t":
        this.scanLiteral("true");
        return;
      case "f":
        this.scanLiteral("false");
        return;
      case "n":
        this.scanLiteral("null");
        return;
      default:
        this.scanNumber();
    }
  }

  private scanObject(depth: number): void {
    this.assertDepth(depth);
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume("}")) return;

    const names = new Set<string>();
    for (;;) {
      if (this.source[this.offset] !== "\"") this.invalid();
      const name = this.scanString();
      if (names.has(name)) throw new SyntaxError("The JSON response contains a duplicate object member.");
      names.add(name);
      this.skipWhitespace();
      if (!this.consume(":")) this.invalid();
      this.skipWhitespace();
      this.scanValue(depth + 1);
      this.skipWhitespace();
      if (this.consume("}")) return;
      if (!this.consume(",")) this.invalid();
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.assertDepth(depth);
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume("]")) return;
    for (;;) {
      this.scanValue(depth + 1);
      this.skipWhitespace();
      if (this.consume("]")) return;
      if (!this.consume(",")) this.invalid();
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.offset;
    this.offset += 1;
    for (;;) {
      if (this.offset >= this.source.length) this.invalid();
      const code = this.source.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      }
      if (code < 0x20) this.invalid();
      this.offset += 1;
      if (code !== 0x5c) continue;
      if (this.offset >= this.source.length) this.invalid();
      const escape = this.source[this.offset];
      this.offset += 1;
      if (escape === "u") {
        for (let index = 0; index < 4; index += 1) {
          const hex = this.source.charCodeAt(this.offset + index);
          if (!isHexDigit(hex)) this.invalid();
        }
        this.offset += 4;
      } else if (escape === undefined || !"\"\\/bfnrt".includes(escape)) {
        this.invalid();
      }
    }
  }

  private scanLiteral(literal: string): void {
    if (!this.source.startsWith(literal, this.offset)) this.invalid();
    this.offset += literal.length;
  }

  private scanNumber(): void {
    if (this.consume("-")) {
      if (this.offset >= this.source.length) this.invalid();
    }
    if (this.consume("0")) {
      if (isDigit(this.source.charCodeAt(this.offset))) this.invalid();
    } else {
      const first = this.source.charCodeAt(this.offset);
      if (first < 0x31 || first > 0x39) this.invalid();
      this.offset += 1;
      while (isDigit(this.source.charCodeAt(this.offset))) this.offset += 1;
    }
    if (this.consume(".")) {
      if (!isDigit(this.source.charCodeAt(this.offset))) this.invalid();
      while (isDigit(this.source.charCodeAt(this.offset))) this.offset += 1;
    }
    const exponent = this.source[this.offset];
    if (exponent === "e" || exponent === "E") {
      this.offset += 1;
      if (this.source[this.offset] === "+" || this.source[this.offset] === "-") this.offset += 1;
      if (!isDigit(this.source.charCodeAt(this.offset))) this.invalid();
      while (isDigit(this.source.charCodeAt(this.offset))) this.offset += 1;
    }
  }

  private assertDepth(depth: number): void {
    if (depth >= MAXIMUM_JSON_DEPTH) {
      throw new SyntaxError("The JSON response exceeds the nesting limit.");
    }
  }

  private skipWhitespace(): void {
    for (;;) {
      const code = this.source.charCodeAt(this.offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.offset += 1;
    }
  }

  private consume(value: string): boolean {
    if (this.source[this.offset] !== value) return false;
    this.offset += 1;
    return true;
  }

  private invalid(): never {
    throw new SyntaxError("The JSON response is malformed.");
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}
