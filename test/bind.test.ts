import { describe, expect, it } from "vitest";
import { isLoopback, resolveBind, TAILSCALE_SENTINEL } from "../src/bind.js";

/**
 * resolveBind is the one safety rule worth testing exhaustively: a mistake here
 * puts every key on the local network. It is a pure function, so these are
 * plain input/output assertions with no sockets involved.
 */
describe("bind safety", () => {
  it("defaults to loopback when nothing is requested", () => {
    const decision = resolveBind({});
    expect(decision.ok).toBe(true);
    expect(decision.host).toBe("127.0.0.1");
    expect(decision.source).toBe("default");
    expect(decision.exposed).toBe(false);
    expect(decision.requireToken).toBe(false);
    expect(decision.warnings).toEqual([]);
  });

  it("refuses 0.0.0.0 and :: without an explicit override", () => {
    for (const host of ["0.0.0.0", "::", "[::]", "*"]) {
      const decision = resolveBind({ requested: host });
      expect(decision.ok, host).toBe(false);
      expect(decision.errors.join(), host).toContain("--allow-all-interfaces");
      // A refused decision must not leak a bindable address.
      expect(decision.host, host).toBe("127.0.0.1");
    }
  });

  it("allows 0.0.0.0 with --allow-all-interfaces, loudly", () => {
    const decision = resolveBind({ requested: "0.0.0.0", allowAllInterfaces: true });
    expect(decision.ok).toBe(true);
    expect(decision.host).toBe("0.0.0.0");
    expect(decision.exposed).toBe(true);
    expect(decision.warnings.join()).toMatch(/every interface/i);
  });

  it("still refuses all-interfaces in gateway mode without the override", () => {
    const decision = resolveBind({ requested: "0.0.0.0", gateway: true, hasToken: true });
    expect(decision.ok).toBe(false);
    expect(decision.errors.join()).toContain("Refusing to bind");
  });

  it("resolves bind: tailscale to the address the caller looked up", () => {
    const decision = resolveBind({
      requested: TAILSCALE_SENTINEL,
      gateway: true,
      hasToken: true,
      tailscaleAddress: "100.101.102.103",
    });
    expect(decision.ok).toBe(true);
    expect(decision.host).toBe("100.101.102.103");
    expect(decision.source).toBe("tailscale");
    expect(decision.exposed).toBe(true);
    expect(decision.requireToken).toBe(true);
    expect(decision.warnings.join()).toMatch(/NOT loopback/);
  });

  it("falls back to the configured address when tailscale cannot be resolved", () => {
    const decision = resolveBind({
      requested: "Tailscale",
      gateway: true,
      hasToken: true,
      tailscaleAddress: null,
      fallbackBind: "192.168.1.50",
    });
    expect(decision.ok).toBe(true);
    expect(decision.host).toBe("192.168.1.50");
    expect(decision.source).toBe("tailscale-fallback");
    expect(decision.warnings.join()).toMatch(/Could not resolve a Tailscale address/);
  });

  it("fails clearly when tailscale is requested with no address and no fallback", () => {
    const decision = resolveBind({ requested: TAILSCALE_SENTINEL, tailscaleAddress: "" });
    expect(decision.ok).toBe(false);
    expect(decision.errors.join()).toContain("tailscale ip -4");
    expect(decision.host).toBe("127.0.0.1");
  });

  it("requires a shared token in gateway mode", () => {
    const decision = resolveBind({
      requested: "100.64.0.1",
      gateway: true,
      hasToken: false,
    });
    expect(decision.ok).toBe(false);
    expect(decision.errors.join()).toContain("gateway.token");
    expect(decision.errors.join()).toContain("SKELETONKEY_GATEWAY_TOKEN");
  });

  it("allows an unauthenticated gateway only with --insecure-no-token", () => {
    const decision = resolveBind({
      requested: "100.64.0.1",
      gateway: true,
      hasToken: false,
      allowNoToken: true,
    });
    expect(decision.ok).toBe(true);
    expect(decision.requireToken).toBe(false);
    expect(decision.warnings.join()).toMatch(/unauthenticated/i);
  });

  it("warns on any non-loopback bind even outside gateway mode", () => {
    const decision = resolveBind({ requested: "192.168.1.10" });
    expect(decision.ok).toBe(true);
    expect(decision.exposed).toBe(true);
    expect(decision.warnings.join()).toMatch(/NOT loopback/);
    expect(decision.warnings.join()).toMatch(/--gateway/);
    // No token is enforced unless gateway mode was asked for.
    expect(decision.requireToken).toBe(false);
  });

  it("treats the whole 127/8 block and ::1 as loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.53")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("100.64.0.1")).toBe(false);
    expect(isLoopback("192.168.1.10")).toBe(false);
  });

  it("does not warn about exposure for a loopback bind in gateway mode", () => {
    const decision = resolveBind({ requested: "127.0.0.1", gateway: true, hasToken: true });
    expect(decision.ok).toBe(true);
    expect(decision.exposed).toBe(false);
    expect(decision.requireToken).toBe(true);
    expect(decision.warnings).toEqual([]);
  });

  it("ignores surrounding whitespace in a requested address", () => {
    expect(resolveBind({ requested: "  " }).host).toBe("127.0.0.1");
    expect(resolveBind({ requested: " 127.0.0.1 " }).host).toBe("127.0.0.1");
    expect(resolveBind({ requested: " 0.0.0.0 " }).ok).toBe(false);
  });
});
