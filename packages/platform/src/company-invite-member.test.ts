/**
 * DEV-5255: `company.inviteMember` is the Team page's real invite. It must hit
 * the same `POST /membership/invite` the CLI and onboarding use, ask hq-pro to
 * send the invitation email, and hand a refusal back with the server's code
 * and sentence.
 */
import { describe, expect, it } from "vitest";
import { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function adapterAnswering(answer: { status: number; body: string }) {
  const calls: Invocation[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd !== "hq_pro_fetch") throw new Error(`unexpected ${cmd}`);
      return answer;
    },
  });
  return { adapter, calls };
}

describe("company.inviteMember (DEV-5255)", () => {
  it("posts an email invite with sendEmail on the desktop surface", async () => {
    const { adapter, calls } = adapterAnswering({
      status: 201,
      body: JSON.stringify({
        membership: { membershipKey: "email:kade@example.com#cmp_acme", inviteeEmail: "kade@example.com", role: "member" },
        resent: false,
        emailSent: true,
        emailSkipped: false,
      }),
    });

    const res = await adapter.company.inviteMember!({
      companyUid: "cmp_acme",
      inviteeEmail: "kade@example.com",
      role: "member",
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args?.url).toBe("/membership/invite");
    expect(calls[0].args?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].args?.body))).toEqual({
      companyUid: "cmp_acme",
      inviteeEmail: "kade@example.com",
      role: "member",
      sendEmail: true,
      inviteSurface: "desktop",
    });
  });

  it("sends guest prefixes and groups only when there are some", async () => {
    const { adapter, calls } = adapterAnswering({ status: 201, body: JSON.stringify({ membership: {} }) });
    await adapter.company.inviteMember!({
      companyUid: "cmp_acme",
      inviteeEmail: "sam@example.com",
      role: "guest",
      allowedPrefixes: ["projects/demo/"],
      groupIds: [],
    });
    const body = JSON.parse(String(calls[0].args?.body));
    expect(body.allowedPrefixes).toEqual(["projects/demo/"]);
    expect(body).not.toHaveProperty("groupIds");
  });

  it("returns the server's code and sentence on a refusal", async () => {
    const { adapter } = adapterAnswering({
      status: 409,
      body: JSON.stringify({ error: "Membership already exists", code: "MEMBERSHIP_ALREADY_EXISTS" }),
    });
    const res = await adapter.company.inviteMember!({
      companyUid: "cmp_acme",
      inviteeEmail: "kade@example.com",
      role: "member",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("MEMBERSHIP_ALREADY_EXISTS");
    expect(res.message).toBe("Membership already exists");
  });
});
