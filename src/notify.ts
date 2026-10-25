/**
 * OS notifications, best effort (D10): the approval surface is an OS
 * notification plus a localhost page. If no notifier exists on this machine the
 * runner still prints the URL and the flow still works -- a missing
 * `notify-send` is never a reason to fall back to asking through the agent.
 */
import { run } from "./vault/exec.js";

export interface Notification {
  title: string;
  body: string;
  /** Shown in the body so the human can copy it; never auto-opened. */
  url?: string;
}

export interface Notifier {
  readonly id: string;
  notify(notification: Notification): Promise<boolean>;
}

type Runner = (command: string, args: string[], stdin?: string) => Promise<{ code: number }>;

/**
 * `notify-send` on Linux, `osascript` on macOS. Nothing on Windows yet, which
 * is reported as `false` rather than pretended away.
 */
export class OsNotifier implements Notifier {
  readonly id = "os";

  constructor(
    private readonly platform: string = process.platform,
    private readonly exec: Runner = run,
  ) {}

  async notify(notification: Notification): Promise<boolean> {
    const body =
      notification.url === undefined
        ? notification.body
        : `${notification.body}\n${notification.url}`;
    try {
      if (this.platform === "darwin") {
        const script = `display notification ${quoteAppleScript(body)} with title ${quoteAppleScript(
          notification.title,
        )}`;
        const result = await this.exec("osascript", ["-e", script]);
        return result.code === 0;
      }
      if (this.platform === "linux") {
        const result = await this.exec("notify-send", [
          "--app-name=SkeletonKey",
          notification.title,
          body,
        ]);
        return result.code === 0;
      }
      return false;
    } catch {
      // ENOENT: the binary is not installed. Best effort means best effort.
      return false;
    }
  }
}

/** Used by tests and by `--no-notify`. */
export class NoopNotifier implements Notifier {
  readonly id = "noop";
  async notify(): Promise<boolean> {
    return false;
  }
}

function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
