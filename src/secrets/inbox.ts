/**
 * Rung 2 of the ladder: the bound inbox, automatic, for email OTPs and magic
 * links only (§5a, D2).
 *
 * v0.3 ships the interface and the filter rules; the IMAP/Gmail reader itself
 * lands in v0.5. Until an inbox is bound, this rung reports "cannot answer" and
 * the ladder falls through to the Secure Input Popup -- it never asks the agent
 * to go and read the mailbox instead.
 */
import type { SecretClass, SecretRequest, SecretResolution, SecretSource } from "./types.js";

export interface InboxMessage {
  /** Sender address, used for the vendor-domain filter. */
  from: string;
  subject: string;
  /** Body text. Only a code or a link is ever taken out of it. */
  body: string;
  /** ISO timestamp, used for the time-window filter. */
  received: string;
}

export interface InboxReader {
  /** The address bound to this agent, or null when nothing is bound yet. */
  boundAddress(): string | null;
  /**
   * Messages from `senderDomain` received within `withinSeconds`. Scope is
   * deliberately narrow (§9: over-broad mail permissions are a risk).
   */
  recent(options: { senderDomain: string; withinSeconds: number }): Promise<InboxMessage[]>;
}

/** Nothing is bound yet. The honest default for v0.3. */
export class UnboundInbox implements InboxReader {
  boundAddress(): null {
    return null;
  }
  async recent(): Promise<InboxMessage[]> {
    return [];
  }
}

/** A 4-10 digit code, the shape every vendor OTP mail uses. */
export function extractOtp(body: string): string | null {
  const match = /\b(\d{4,10})\b/.exec(body);
  return match?.[1] ?? null;
}

/** The first https link, for a magic-link verification mail. */
export function extractMagicLink(body: string): string | null {
  const match = /https:\/\/[^\s"'<>)]+/.exec(body);
  return match?.[0] ?? null;
}

export class BoundInboxSource implements SecretSource {
  readonly id = "inbox" as const;
  private detail: string | null = null;

  constructor(
    private readonly reader: InboxReader = new UnboundInbox(),
    private readonly withinSeconds = 600,
  ) {}

  handles(secretClass: SecretClass): boolean {
    return secretClass === "otp";
  }

  lastDetail(): string | null {
    return this.detail;
  }

  async resolve(request: SecretRequest): Promise<SecretResolution | null> {
    this.detail = null;
    if (!this.handles(request.class)) {
      this.detail = "The inbox rung only answers email OTPs and magic links.";
      return null;
    }
    const bound = this.reader.boundAddress();
    if (bound === null) {
      this.detail =
        "No inbox is bound to this agent yet (v0.5 binds one), so the ladder falls through to the " +
        "Secure Input Popup. The agent is never asked to read the mailbox in its place.";
      return null;
    }
    const senderDomain = senderDomainFor(request);
    if (senderDomain === null) {
      this.detail = "No vendor domain to filter the mailbox by; refusing to read it unfiltered.";
      return null;
    }
    const messages = await this.reader.recent({ senderDomain, withinSeconds: this.withinSeconds });
    for (const message of messages) {
      if (!message.from.toLowerCase().endsWith(senderDomain)) continue;
      const code = extractOtp(message.body) ?? extractMagicLink(message.body);
      if (code === null) continue;
      return {
        source: "inbox",
        value: code,
        detail:
          `Read the ${request.field} out of a message from ${senderDomain} in the bound inbox ` +
          `(${bound}), within ${this.withinSeconds}s. The runner filled it; the agent never saw it.`,
      };
    }
    this.detail =
      `No message from ${senderDomain} with a code arrived in the bound inbox within ` +
      `${this.withinSeconds}s.`;
    return null;
  }
}

function senderDomainFor(request: SecretRequest): string | null {
  try {
    const host = new URL(request.origin).hostname.toLowerCase();
    const parts = host.split(".");
    // Registrable-ish domain: good enough to filter `noreply@mail.vendor.com`.
    return parts.length >= 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}
