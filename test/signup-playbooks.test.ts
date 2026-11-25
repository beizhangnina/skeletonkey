/**
 * ND-2: pins the first-wave vendor table against the facts given in the spec
 * (verified against each vendor's own docs on 2026-11-24). A change here
 * should mean the table was deliberately updated, not that a typo crept in.
 */
import { describe, expect, it } from "vitest";
import {
  SIGNUP_VENDORS,
  listSignupPlaybooks,
  signupPlaybook,
  type SignupPlaybook,
} from "../src/signup/playbooks.js";

describe("ND-2 signup playbooks", () => {
  it("lists exactly the six first-wave vendors", () => {
    expect(SIGNUP_VENDORS).toEqual(["apify", "serpapi", "firecrawl", "exa", "github", "apollo"]);
  });

  it("every playbook is human-handoff (no bundled driver exists)", () => {
    for (const playbook of listSignupPlaybooks()) {
      expect(playbook.automation).toBe("human-handoff");
    }
  });

  it("is case-insensitive and returns null for an unknown vendor", () => {
    expect(signupPlaybook("APIFY")?.vendor).toBe("apify");
    expect(signupPlaybook(" Apify ")?.vendor).toBe("apify");
    expect(signupPlaybook("totally-unknown-vendor")).toBeNull();
  });

  const byVendor = new Map(listSignupPlaybooks().map((p) => [p.vendor, p]));

  function expectPlaybook(vendor: string, expected: Partial<SignupPlaybook>): void {
    const playbook = byVendor.get(vendor);
    expect(playbook, vendor).toBeDefined();
    for (const [key, value] of Object.entries(expected)) {
      expect((playbook as unknown as Record<string, unknown>)[key], `${vendor}.${key}`).toEqual(value);
    }
  }

  it("apify", () => {
    expectPlaybook("apify", {
      signupUrl: "https://console.apify.com/sign-up",
      keyPageUrl: "https://console.apify.com/settings/integrations",
      docs: "https://docs.apify.com/platform/integrations/api",
      domain: "api.apify.com",
      header: "Authorization",
      format: "Bearer {key}",
      envHint: "APIFY_TOKEN",
      injection: "header",
    });
  });

  it("serpapi: env-only, no key-page URL", () => {
    expectPlaybook("serpapi", {
      signupUrl: "https://serpapi.com/users/sign_up",
      keyPageUrl: null,
      docs: "https://serpapi.com/account-api",
      domain: "serpapi.com",
      header: null,
      format: null,
      envHint: "SERPAPI_API_KEY",
      injection: "env-only",
    });
  });

  it("firecrawl", () => {
    expectPlaybook("firecrawl", {
      signupUrl: "https://www.firecrawl.dev/signin",
      keyPageUrl: "https://www.firecrawl.dev/app/api-keys",
      docs: "https://docs.firecrawl.dev/api-reference/introduction",
      domain: "api.firecrawl.dev",
      header: "Authorization",
      format: "Bearer {key}",
      envHint: "FIRECRAWL_API_KEY",
      injection: "header",
    });
  });

  it("exa", () => {
    expectPlaybook("exa", {
      signupUrl: "https://dashboard.exa.ai/login",
      keyPageUrl: "https://dashboard.exa.ai/api-keys",
      docs: "https://exa.ai/docs/reference/search",
      domain: "api.exa.ai",
      header: "x-api-key",
      format: "{key}",
      envHint: "EXA_API_KEY",
      injection: "header",
    });
  });

  it("github", () => {
    expectPlaybook("github", {
      signupUrl: "https://github.com/signup",
      keyPageUrl: "https://github.com/settings/personal-access-tokens/new",
      docs: "https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api",
      domain: "api.github.com",
      header: "Authorization",
      format: "Bearer {key}",
      envHint: "GITHUB_TOKEN",
      injection: "header",
    });
  });

  it("apollo: no signup URL, only a key-page URL", () => {
    expectPlaybook("apollo", {
      signupUrl: null,
      keyPageUrl: "https://app.apollo.io/#/settings/integrations",
      docs: "https://docs.apollo.io/docs/create-api-key",
      domain: "api.apollo.io",
      header: "x-api-key",
      format: "{key}",
      envHint: "APOLLO_API_KEY",
      injection: "header",
    });
  });

  it("every playbook has at least one human step, and none mentions a secret", () => {
    for (const playbook of listSignupPlaybooks()) {
      expect(playbook.humanSteps.length).toBeGreaterThan(0);
      for (const step of playbook.humanSteps) {
        expect(step.toLowerCase()).not.toMatch(/api[_-]?key value|password:|secret:/);
      }
    }
  });
});
