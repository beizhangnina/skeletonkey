import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("tarball contains only distributable files and every installed bin works", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/check-pack.mjs", import.meta.url))], {
    encoding: "utf8",
    timeout: 240_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(output).toContain("Package check passed:");
}, 250_000);
