import { run } from "./vault/exec.js";

/** First IPv4 address Tailscale reports for this host, or null. */
export async function tailscaleIPv4(): Promise<string | null> {
  let result;
  try {
    result = await run("tailscale", ["ip", "-4"]);
  } catch {
    // `tailscale` not installed.
    return null;
  }
  if (result.code !== 0) return null;
  const first = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line));
  return first ?? null;
}
