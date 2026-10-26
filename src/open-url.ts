/**
 * Best-effort "open this page in the human's browser".
 *
 * Used by the `init` wizard for one thing only: the Bitwarden signup page.
 * SkeletonKey never creates the account, never fills the form, and never sees
 * the master password -- it just saves the human a copy-paste. Every caller
 * prints the URL as well, so a failure here is cosmetic.
 *
 * The opener is injected everywhere it is used (`UrlOpener`), so the test
 * suite never spawns a browser.
 */
import { spawn } from "node:child_process";

/** Returns true when a browser was launched, false when it could not be. */
export type UrlOpener = (url: string) => Promise<boolean>;

/** Opens the URL with the platform's handler. Never throws. */
export async function openUrl(url: string): Promise<boolean> {
  // Only ever hand the shell handler an https URL this codebase built itself.
  if (!/^https:\/\/[\w.-]+/.test(url)) return false;
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => done(false));
      child.on("spawn", () => {
        // The browser outlives this process; nothing is waited on.
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

/** The real opener. `init` takes this as a dependency so tests can fake it. */
export function systemOpener(): UrlOpener {
  return openUrl;
}

/** An opener that does nothing, for a non-interactive run. */
export function noopOpener(): UrlOpener {
  return async () => false;
}
