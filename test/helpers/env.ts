import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(REPO_ROOT, "dist", "cli.js");

export function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-test-"));
}

export function removeHome(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI with SKELETONKEY_HOME pointed at a temp directory. */
export function runCli(
  home: string,
  args: string[],
  stdin?: string,
): Promise<CliResult> {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing. Run \`npm run build\` first (npm test does this for you).`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], {
      env: {
        ...process.env,
        SKELETONKEY_HOME: home,
        SKELETONKEY_ALLOW_TEST_BACKEND: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

/** `init --backend file` plus one key, the setup most tests need. */
export async function initWithKey(
  home: string,
  options: {
    alias?: string;
    secret?: string;
    domain?: string;
    header?: string;
    format?: string;
  } = {},
): Promise<{ alias: string; secret: string }> {
  const alias = options.alias ?? "demo";
  const secret = options.secret ?? "sk-test-FAKE-0001";
  const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  const add = await runCli(
    home,
    [
      "add",
      alias,
      "--platform",
      "ExampleCo",
      "--domain",
      options.domain ?? "127.0.0.1",
      "--header",
      options.header ?? "Authorization",
      "--format",
      options.format ?? "Bearer {key}",
    ],
    secret,
  );
  if (add.code !== 0) throw new Error(`add failed: ${add.stderr}`);
  return { alias, secret };
}
