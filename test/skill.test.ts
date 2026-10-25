import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers/env.js";

/**
 * The skill file is the only instruction an agent reads before it starts a
 * signup, so the rules that keep a key (and a user's inbox) safe are asserted
 * here the same way the code is.
 */
const SKILL = fs.readFileSync(
  path.join(REPO_ROOT, "skills", "skeletonkey", "SKILL.md"),
  "utf8",
);

describe("skills/skeletonkey/SKILL.md", () => {
  it("still starts with the frontmatter an agent loader needs", () => {
    expect(SKILL.startsWith("---\n")).toBe(true);
    expect(SKILL).toMatch(/^name: skeletonkey$/m);
    expect(SKILL).toMatch(/^description: .+/m);
  });

  it("tells the agent to read verification codes from its own inbox", () => {
    const section = SKILL.slice(SKILL.indexOf("### 2b."), SKILL.indexOf("### 3."));
    expect(section).not.toBe("");
    expect(section).toMatch(/own email connector or inbox/i);
    expect(section).toMatch(/verification code/i);
    expect(section).toMatch(/confirmation link/i);
    expect(section).toMatch(/email_verification/);
    // Only the code or the link leaves the mailbox -- not the message.
    expect(section).toMatch(/Do not copy the message into a file/i);
    // And it says what to do with no inbox, instead of leaning on the user.
    expect(section).toMatch(/no\*\* inbox access|no inbox access/i);
    expect(section).toMatch(/do not ask them to forward/i);
  });

  it("forbids a +alias where the vendor requires a work email", () => {
    expect(SKILL).toMatch(/requires_work_email/);
    expect(SKILL).toMatch(/do not use a `\+alias`|Never sign up with a `\+alias`/i);
    expect(SKILL).toMatch(/alias_allowed/);
    // The address itself is the user's call, not the agent's.
    expect(SKILL).toMatch(/never pick a work address on the user's behalf/i);
  });

  it("documents the human gates and the merged index", () => {
    expect(SKILL).toMatch(/human_gates/);
    expect(SKILL).toMatch(/skeletonkey-policy/);
    expect(SKILL).toMatch(/data\/apis\/\*\.yaml/);
  });

  it("tells the agent what a disabled key and a stale row mean", () => {
    expect(SKILL).toMatch(/key_disabled/);
    expect(SKILL).toMatch(/skeletonkey enable <alias>/);
    expect(SKILL).toMatch(/freshness\.stale/);
    expect(SKILL).toMatch(/search_terms/);
    expect(SKILL).toMatch(/ignored_terms/);
  });

  it("tells the agent never to guess an auth header", () => {
    expect(SKILL).toMatch(/Never guess an auth header/i);
    expect(SKILL).toMatch(/auth_header` is `null`/);
  });

  it("explains the route table and the words `price unverified`", () => {
    const section = SKILL.slice(SKILL.indexOf("### 1a."), SKILL.indexOf("### 1b."));
    expect(section).not.toBe("");
    for (const route of ["`direct`", "`aggregator:<name>`", "`x402`", "`unknown`"]) {
      expect(section, route).toContain(route);
    }
    expect(section).toMatch(/price unverified/);
    expect(section).toMatch(/billing\.model: null` means nobody checked/);
    expect(section).toMatch(/never means free/);
    expect(section).toMatch(/per_call_price: null/);
    expect(section).toMatch(/stale-check/);
    // A money route never overrides a human gate.
    expect(section).toMatch(/never overrides a human\s+gate/);
  });

  it("tells the agent to discover on a miss instead of guessing", () => {
    const section = SKILL.slice(SKILL.indexOf("### 1b."), SKILL.indexOf("### 2. No key?"));
    expect(section).not.toBe("");
    expect(section).toMatch(/discover_api/);
    expect(section).toMatch(/propose_entry/);
    expect(section).toMatch(/A miss is not permission to invent/i);
    // The recipe's sources, in the order the tool returns them.
    expect(section).toMatch(/own API docs/);
    expect(section).toMatch(/own pricing page/);
    expect(section).toMatch(/OpenAPI\/Swagger/);
    expect(section).toMatch(/APIs\.guru/);
    // The promotion contract, stated as a rule the agent cannot route around.
    expect(section).toMatch(/status: unverified/);
    expect(section).toMatch(/cannot\s*\n?\s*verify your own research|cannot verify your own research/);
    expect(section).toMatch(/2xx/);
    expect(section).toMatch(/source_urls/);
  });

  it("forbids quoting an unverified price or self-verifying a discovery", () => {
    expect(SKILL).toMatch(/Never quote a price whose `verified_url`/);
    expect(SKILL).toMatch(/Never mark your own discovery verified/);
  });

  it("describes the v0.3 async approval flow and the tools that drive it", () => {
    for (const tool of ["access_status", "cancel_request", "spend_policy"]) {
      expect(SKILL, tool).toContain(tool);
    }
    const section = SKILL.slice(SKILL.indexOf("### 2. No key?"), SKILL.indexOf("### 2a."));
    expect(section).toMatch(/pending_approval/);
    expect(section).toMatch(/outside this\s+conversation|out of band/i);
    expect(section).toMatch(/Poll `access_status/);
    expect(section).toMatch(/Do not ask the user to approve it here/);
    expect(section).toMatch(/needs_human/);
    // The caps and the kill switch, as rules the agent cannot route around.
    expect(section).toMatch(/start at \*\*\$0\*\*/);
    expect(section).toMatch(/can never raise one/);
    expect(section).toMatch(/kill_switch/);
    expect(section).toMatch(/skeletonkey resume/);
  });

  it("forbids collecting a card, a password, or an OTP through the agent", () => {
    expect(SKILL).toMatch(/Never ask a human for a card number, a CVV, a password, or an OTP/);
    expect(SKILL).toMatch(/Secure Input Popup/);
    expect(SKILL).toMatch(/Never approve your own request/);
    expect(SKILL).toMatch(/never ask for a cap to be raised/);
  });

  it("points at the trusted runner, and says it cannot return a secret", () => {
    expect(SKILL).toMatch(/trusted runner/);
    expect(SKILL).toMatch(/skeletonkey runner/);
    expect(SKILL).toMatch(/no\s+verb that returns a secret value/);
    expect(SKILL).toMatch(/runner_unavailable/);
  });

  it("keeps the no-secrets rules it had before", () => {
    expect(SKILL).toMatch(/Never ask a human to tell you, type into chat, or paste an API key/);
    expect(SKILL).toMatch(/Never complete a payment or accept terms on the user's behalf/);
    // No instruction anywhere to read, echo, or store a key value.
    expect(SKILL).not.toMatch(/paste the key into|echo the key|save the key to/i);
  });
});
