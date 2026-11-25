/**
 * Streaming redaction: a Transform that scrubs known secret values out of a
 * byte stream without ever splitting one in half.
 *
 * The hard part is the chunk boundary. A secret can arrive one byte at a time,
 * so the transform keeps a tail of the stream back until it is sure that no
 * secret straddles the point where it would emit.
 *
 * How much is held back: the longest known value minus one character. That is
 * enough for any secret that has not finished arriving, because a secret of
 * length L is at most L-1 characters of "not yet arrived". Values longer than
 * `maxValueLength` (4096 by default) are a documented limitation: they are
 * only matched inside a single chunk.
 *
 * A second guard handles a secret that *is* complete but sits across the
 * boundary we were about to cut: the cut moves back to the start of that
 * secret, and the whole thing is held for the next round.
 */
import { StringDecoder } from "node:string_decoder";
import { Transform, type TransformCallback } from "node:stream";
import { REDACTED, redactShapes, type Redactor } from "../redact.js";

/** The longest tail buffer we are willing to keep. */
export const MAX_TAIL_CHARACTERS = 4096;

export interface RedactingStreamOptions {
  /** Cap on the tail buffer. Longer values are matched within a chunk only. */
  maxValueLength?: number;
}

/**
 * A Transform that replaces every known secret value with `[redacted]`, and
 * applies the secret-shape rules to whatever is left.
 */
export function createRedactingStream(
  redactor: Redactor,
  options: RedactingStreamOptions = {},
): Transform {
  const values = redactor.knownValues();
  const longest = values.reduce((max, value) => Math.max(max, value.length), 0);
  const cap = options.maxValueLength ?? MAX_TAIL_CHARACTERS;
  // How many characters have to stay back for an arriving secret to be safe.
  const keep = longest === 0 ? 0 : Math.min(longest, cap) - 1;
  const decoder = new StringDecoder("utf8");
  let pending = "";

  /**
   * How much of `pending` can be emitted without cutting a secret in half.
   *
   * Starts at "everything but the tail", then moves back for every secret that
   * would straddle the cut.
   */
  function safeBoundary(buffer: string): number {
    let boundary = Math.max(0, buffer.length - keep);
    let moved = true;
    while (moved) {
      moved = false;
      for (const secret of values) {
        let index = buffer.indexOf(secret);
        while (index !== -1) {
          const end = index + secret.length;
          if (index < boundary && end > boundary) {
            boundary = index;
            moved = true;
          }
          index = buffer.indexOf(secret, index + 1);
        }
      }
    }
    return boundary;
  }

  /** Replaces the known values in a chunk that is safe to emit. */
  function redactText(text: string): string {
    let out = text;
    for (const secret of values) {
      if (secret === "") continue;
      out = out.split(secret).join(REDACTED);
    }
    return redactShapes(out);
  }

  function push(stream: Transform, text: string): void {
    if (text === "") return;
    stream.push(text);
  }

  return new Transform({
    decodeStrings: true,
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
      pending += decoder.write(chunk);
      const boundary = safeBoundary(pending);
      if (boundary > 0) {
        push(this, redactText(pending.slice(0, boundary)));
        pending = pending.slice(boundary);
      }
      callback();
    },
    flush(callback: TransformCallback): void {
      pending += decoder.end();
      // Nothing more is coming, so the tail is emitted as it stands.
      push(this, redactText(pending));
      pending = "";
      callback();
    },
  });
}
