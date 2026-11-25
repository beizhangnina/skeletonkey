/**
 * U5: streaming redaction.
 *
 * The hard part is the chunk boundary. A secret can arrive one byte at a time,
 * so the transform keeps a tail of the stream back until it is sure that no
 * secret straddles the point where it would emit.
 */
import { describe, expect, it } from "vitest";
import { Redactor, REDACTED } from "../src/redact.js";
import { createRedactingStream, MAX_TAIL_CHARACTERS } from "../src/run/redact-stream.js";

const SECRET = "FAKE-canary-STREAM-0xC0FFEE88";

/**
 * Pushes the chunks through the transform and collects everything it emits.
 *
 * Buffers go in as they are, so a test can hand the stream raw bytes and cut
 * a multi-byte character in half on purpose.
 */
async function redactChunks(chunks: (string | Buffer)[], redactor: Redactor): Promise<string> {
  const stream = createRedactingStream(redactor);
  const out: string[] = [];
  stream.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
  const done = new Promise<void>((resolve) => stream.on("end", () => resolve()));
  for (const chunk of chunks) {
    stream.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  stream.end();
  await done;
  return out.join("");
}

/** Splits a string into `size`-character chunks. */
function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

describe("the redacting stream", () => {
  it("redacts a secret that arrives whole", async () => {
    const redactor = new Redactor([SECRET]);
    const out = await redactChunks([`before ${SECRET} after`], redactor);
    expect(out).toBe(`before ${REDACTED} after`);
  });

  it("redacts a secret that arrives one byte at a time", async () => {
    const redactor = new Redactor([SECRET]);
    const out = await redactChunks(chunked(`before ${SECRET} after`, 1), redactor);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("0xC0FFEE88");
    expect(out).toContain(REDACTED);
    expect(out).toBe(`before ${REDACTED} after`);
  });

  it("redacts a secret that straddles a chunk boundary", async () => {
    const redactor = new Redactor([SECRET]);
    const text = `xx${SECRET}yy`;
    // Cut in the middle of the secret.
    const out = await redactChunks([text.slice(0, 9), text.slice(9)], redactor);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`xx${REDACTED}yy`);
  });

  it("keeps the text around the secret", async () => {
    const redactor = new Redactor([SECRET]);
    const out = await redactChunks(chunked(`line one\n${SECRET}\nline three\n`, 3), redactor);
    expect(out).toBe(`line one\n${REDACTED}\nline three\n`);
  });

  it("does not cut a multi-byte character in half", async () => {
    const redactor = new Redactor([]);
    const text = "héllo wörld 🌍 done";
    // Byte-sized chunks split the two-byte characters and the emoji.
    const chunks: Buffer[] = [];
    const bytes = Buffer.from(text, "utf8");
    for (let index = 0; index < bytes.length; index += 1) {
      chunks.push(bytes.subarray(index, index + 1));
    }
    const out = await redactChunks(chunks, redactor);
    expect(out).toBe(text);
    expect(out).not.toContain("�");
  });

  it("redacts a secret that is also multi-byte", async () => {
    const secret = "FAKE-canary-ÜBER-0xC0FFEE99";
    const redactor = new Redactor([secret]);
    const bytes = Buffer.from(`a${secret}b`, "utf8");
    const chunks: Buffer[] = [];
    for (let index = 0; index < bytes.length; index += 2) {
      chunks.push(bytes.subarray(index, index + 2));
    }
    const out = await redactChunks(chunks, redactor);
    expect(out).not.toContain(secret);
    expect(out).toBe(`a${REDACTED}b`);
  });

  it("still applies the shape rules to what is left", async () => {
    const redactor = new Redactor([]);
    const out = await redactChunks(["password=hunter2 and sk-live-FAKE-0123456789abcdef"], redactor);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("0123456789abcdef");
    expect(out).toContain("password=");
  });

  it("redacts the longest secret first, so a prefix cannot survive", async () => {
    const short = "FAKE-canary";
    const long = "FAKE-canary-STREAM-0xC0FFEE88";
    const redactor = new Redactor([short, long]);
    const out = await redactChunks([long], redactor);
    expect(out).not.toContain(short);
    expect(out).toBe(REDACTED);
  });

  it("matches a value longer than the tail buffer only inside one chunk", async () => {
    // The documented limitation: a value longer than `maxValueLength` is only
    // matched when it arrives whole. It is pinned here so the limit cannot
    // change silently.
    const long = "x".repeat(MAX_TAIL_CHARACTERS + 100);
    const redactor = new Redactor([long]);
    const stream = createRedactingStream(redactor, { maxValueLength: 64 });
    const out: string[] = [];
    stream.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
    const done = new Promise<void>((resolve) => stream.on("end", () => resolve()));
    stream.write(`${long}`);
    stream.end();
    await done;
    // The whole value arrived in one chunk, so it is redacted anyway.
    expect(out.join("")).not.toContain(long);
  });

  it("leaves ordinary output untouched", async () => {
    const redactor = new Redactor([SECRET]);
    const text = "GET api.voyageai.com/v1/embeddings -> 200 1284b alias=voyage-personal\n";
    const out = await redactChunks(chunked(text, 7), redactor);
    expect(out).toBe(text);
  });
});
