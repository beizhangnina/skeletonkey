import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a helper CLI. Secrets are passed on stdin, never in argv, so they do not
 * show up in `ps` output or shell history.
 */
export function run(
  command: string,
  args: string[],
  stdin?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`\`${command}\` was not found on PATH.`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await run("/usr/bin/env", ["which", command]);
    return result.code === 0;
  } catch {
    return false;
  }
}
