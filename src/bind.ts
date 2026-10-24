/**
 * Deciding what address the proxy may listen on is the one piece of this tool
 * where a mistake silently exposes every key you own to the local network. It
 * is therefore a pure function with no I/O: the caller resolves Tailscale
 * addresses and reads config, this decides.
 */

export const LOOPBACK = "127.0.0.1";

/** Literals that mean "every interface on this machine". */
const ALL_INTERFACES = new Set(["0.0.0.0", "::", "[::]", "*", "", "::0", "0"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Sentinel accepted in `gateway.bind` / `--bind` to mean "this host's tailnet IP". */
export const TAILSCALE_SENTINEL = "tailscale";

export interface BindRequest {
  /** `--bind`, else `gateway.bind` / `proxy.bind` from config. */
  requested?: string | undefined;
  /** True when the user asked for gateway mode (`--gateway`). */
  gateway?: boolean;
  /** `--allow-all-interfaces`, or `gateway.allow_all_interfaces` in config. */
  allowAllInterfaces?: boolean;
  /**
   * Result of `tailscale ip -4`, or null when Tailscale is absent or the host
   * is not logged in. Resolved by the caller so this function stays pure.
   */
  tailscaleAddress?: string | null | undefined;
  /** Address to use when `tailscale` was asked for but could not be resolved. */
  fallbackBind?: string | undefined;
  /** A shared gateway token is configured (value never needed here). */
  hasToken?: boolean;
  /** `--insecure-no-token`: run gateway mode with no shared token. */
  allowNoToken?: boolean;
}

export interface BindDecision {
  ok: boolean;
  /** Address to pass to `server.listen`. Only meaningful when `ok`. */
  host: string;
  /** Why the decision failed. Empty when `ok`. */
  errors: string[];
  /** Things the user should see on stderr before traffic flows. */
  warnings: string[];
  /** True when requests must carry a matching `X-SkeletonKey-Token`. */
  requireToken: boolean;
  /** How `requested` was interpreted. */
  source: "default" | "explicit" | "tailscale" | "tailscale-fallback";
  /** True when the chosen address is reachable from outside this machine. */
  exposed: boolean;
}

function isAllInterfaces(host: string): boolean {
  return ALL_INTERFACES.has(host.trim().toLowerCase());
}

export function isLoopback(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(value)) return true;
  // The whole 127/8 block is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Resolves the bind address, refusing the footguns:
 *   - `0.0.0.0` / `::` need an explicit `--allow-all-interfaces`.
 *   - `bind: tailscale` needs a resolvable tailnet address or a fallback.
 *   - gateway mode needs a shared token unless explicitly waived.
 * Any non-loopback bind warns, because the proxy spends real money.
 */
export function resolveBind(request: BindRequest): BindDecision {
  const errors: string[] = [];
  const warnings: string[] = [];
  const gateway = request.gateway === true;

  let source: BindDecision["source"] = "default";
  let host = LOOPBACK;

  const requested = request.requested?.trim() ?? "";
  if (requested !== "") {
    if (requested.toLowerCase() === TAILSCALE_SENTINEL) {
      const tailnet = request.tailscaleAddress?.trim() ?? "";
      if (tailnet !== "") {
        host = tailnet;
        source = "tailscale";
      } else if ((request.fallbackBind ?? "").trim() !== "") {
        host = (request.fallbackBind ?? "").trim();
        source = "tailscale-fallback";
        warnings.push(
          "Could not resolve a Tailscale address (`tailscale ip -4`); falling back to " +
            `${host}. Is tailscaled running and this host logged in?`,
        );
      } else {
        errors.push(
          "bind: tailscale could not be resolved -- `tailscale ip -4` returned no address. " +
            "Start Tailscale, or set gateway.fallback_bind / pass --bind <address>.",
        );
        return {
          ok: false,
          host: LOOPBACK,
          errors,
          warnings,
          requireToken: gateway,
          source: "tailscale",
          exposed: false,
        };
      }
    } else {
      host = requested;
      source = "explicit";
    }
  }

  if (isAllInterfaces(host)) {
    if (request.allowAllInterfaces !== true) {
      errors.push(
        `Refusing to bind ${JSON.stringify(host)}: that exposes your keys on every ` +
          "interface, including untrusted networks. Bind a specific address " +
          "(e.g. --bind tailscale), or pass --allow-all-interfaces if you really mean it.",
      );
    } else {
      warnings.push(
        `Binding ${host}: every interface on this machine can reach the proxy and ` +
          "spend through your keys. Make sure a firewall is in front of it.",
      );
    }
  }

  const exposed = !isLoopback(host);
  if (exposed && errors.length === 0) {
    warnings.push(
      `Binding ${host}, which is NOT loopback: anything that can reach this address ` +
        "can spend through your keys. Keep it on a private network (e.g. a tailnet).",
    );
  }

  if (gateway) {
    if (request.hasToken !== true) {
      if (request.allowNoToken === true) {
        warnings.push(
          "Gateway mode with no shared token (--insecure-no-token): every device that " +
            "can reach this port can use your keys, unauthenticated.",
        );
      } else {
        errors.push(
          "Gateway mode needs a shared token. Set `gateway.token` in config.yaml, or " +
            "export SKELETONKEY_GATEWAY_TOKEN, or pass --token <value>. " +
            "Use --insecure-no-token to run without one.",
        );
      }
    }
  } else if (exposed && errors.length === 0 && request.hasToken !== true) {
    warnings.push(
      "This is not gateway mode, so no X-SkeletonKey-Token is required. Pass --gateway to " +
        "require a shared token from callers.",
    );
  }

  return {
    ok: errors.length === 0,
    host: errors.length === 0 ? host : LOOPBACK,
    errors,
    warnings,
    requireToken: gateway && (request.hasToken === true || request.allowNoToken !== true),
    source,
    exposed,
  };
}
