import readline from "node:readline/promises";

export async function promptLine(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    const trimmed = answer.trim();
    return trimmed === "" && fallback !== undefined ? fallback : trimmed;
  } finally {
    rl.close();
  }
}

/** Reads a line from the TTY without echoing it. */
export function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(
      new Error("stdin is not a TTY; pipe the secret instead (e.g. `... | skeletonkey add ...`)."),
    );
  }
  return new Promise<string>((resolve, reject) => {
    process.stderr.write(question);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const cleanup = (): void => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("aborted"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}

/** Everything piped on stdin, with one trailing newline removed. */
export function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

/**
 * Secrets come from stdin when the CLI is piped (scripts, tests) and from a
 * hidden prompt when a human is at the terminal.
 */
export async function readSecret(forceStdin = false): Promise<string> {
  if (forceStdin || !process.stdin.isTTY) return readStdin();
  return promptHidden("Secret (not echoed): ");
}

/**
 * Reads a secret from the controlling terminal (`/dev/tty`) rather than stdin.
 *
 * This is what lets the MCP server ask a human for a key: stdin there is the
 * JSON-RPC pipe, so the question has to go somewhere else entirely. Returns
 * null when there is no usable terminal, and the caller then tells the agent to
 * instruct the human to run `skeletonkey add`.
 */
export async function promptHiddenOnTty(question: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  const fs = await import("node:fs");
  const tty = await import("node:tty");
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  if (!tty.isatty(fd)) {
    fs.closeSync(fd);
    return null;
  }
  const input = new tty.ReadStream(fd);
  return new Promise<string | null>((resolve) => {
    let value = "";
    const finish = (result: string | null): void => {
      input.removeListener("data", onData);
      try {
        input.setRawMode(false);
      } catch {
        // The stream may already be torn down.
      }
      fs.writeSync(fd, "\n");
      input.destroy();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003" || char === "\u0004") return finish(null);
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    try {
      fs.writeSync(fd, question);
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    } catch {
      finish(null);
    }
  });
}
