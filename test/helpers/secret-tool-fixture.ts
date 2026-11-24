import fs from "node:fs";
import path from "node:path";

/**
 * A fake `secret-tool` (Linux libsecret CLI) for exercising
 * `src/vault/keychain.ts` on a box with no real Secret Service running.
 *
 * This is NOT a real OS keyring: it is a tiny Node script that speaks just
 * enough of `secret-tool`'s argv shape (`store --label L attr val ...`,
 * `lookup attr val ...`, `clear attr val ...`, `search --all attr val`) to
 * stand in for it, backed by a JSON file named by `SECRET_TOOL_FIXTURE_STORE`.
 * Every test that uses it says so in its description.
 */
export function writeSecretToolFixture(dir: string): { dir: string; storeFile: string } {
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, "secret-tool-store.json");
  const scriptPath = path.join(dir, "secret-tool");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");

const storeFile = process.env.SECRET_TOOL_FIXTURE_STORE;
if (!storeFile) {
  process.stderr.write("fixture secret-tool: SECRET_TOOL_FIXTURE_STORE is not set\\n");
  process.exit(1);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storeFile, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(storeFile, JSON.stringify(data));
}

function parseAttrs(rest) {
  const attrs = {};
  for (let i = 0; i + 1 < rest.length; i += 2) attrs[rest[i]] = rest[i + 1];
  return attrs;
}

function recordKey(attrs) {
  return \`\${attrs.service || ""}\\u0000\${attrs.account || ""}\`;
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "store") {
  let rest = args.slice(1);
  if (rest[0] === "--label") rest = rest.slice(2);
  const attrs = parseAttrs(rest);
  let secret = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (secret += chunk));
  process.stdin.on("end", () => {
    const data = load();
    data[recordKey(attrs)] = secret.replace(/\\n$/, "");
    save(data);
    process.exit(0);
  });
} else if (cmd === "lookup") {
  const attrs = parseAttrs(args.slice(1));
  const data = load();
  const value = data[recordKey(attrs)];
  if (value === undefined) process.exit(1);
  process.stdout.write(value + "\\n");
  process.exit(0);
} else if (cmd === "clear") {
  const attrs = parseAttrs(args.slice(1));
  const data = load();
  delete data[recordKey(attrs)];
  save(data);
  process.exit(0);
} else if (cmd === "search") {
  // Only used as a liveness probe by KeychainVault.check(); nothing to report.
  process.exit(0);
} else {
  process.stderr.write(\`fixture secret-tool: unknown command \${cmd}\\n\`);
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  fs.chmodSync(scriptPath, 0o755);
  if (!fs.existsSync(storeFile)) fs.writeFileSync(storeFile, "{}");
  return { dir, storeFile };
}
