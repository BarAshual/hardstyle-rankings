import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  oauth: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
import { createAPI, friendlyError, nicknameError } from "../../src/api";
beforeEach(() => {
  mocks.create.mockReturnValue({
    auth: {
      exchangeCodeForSession: mocks.exchange,
      signInWithOAuth: mocks.oauth,
    },
  });
});
describe("client boundary", () => {
  it("uses PKCE, persists sessions, and exchanges each callback code only once", async () => {
    mocks.exchange.mockResolvedValue({
      data: { user: { id: "u" } },
      error: null,
    });
    const api = createAPI("http://127.0.0.1:54321", "sb_publishable_test");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      {
        auth: {
          flowType: "pkce",
          detectSessionInUrl: false,
          persistSession: true,
          autoRefreshToken: true,
        },
      },
    );
    const [a, b] = await Promise.all([
      api.complete("once"),
      api.complete("once"),
    ]);
    expect(a).toEqual(b);
    expect(mocks.exchange).toHaveBeenCalledOnce();
  });
  it("uses Supabase Google OAuth with the fixed application callback", async () => {
    mocks.oauth.mockResolvedValue({ error: null });
    await createAPI("http://127.0.0.1:54321", "sb_publishable_test").signIn();
    expect(mocks.oauth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { prompt: "select_account" },
      },
    });
  });
  it("rejects missing or privileged browser configuration", () => {
    expect(() => createAPI("", "")).toThrow();
    expect(() => createAPI("http://127.0.0.1", "sb_secret_unsafe")).toThrow();
    const key =
      "eyJ." + btoa(JSON.stringify({ role: "service_role" })) + ".signature";
    expect(() => createAPI("http://127.0.0.1", key)).toThrow();
  });
  it("validates Unicode nickname length and avoids raw errors", () => {
    expect(nicknameError("   ")).toBeTruthy();
    expect(nicknameError("a".repeat(81))).toBeTruthy();
    expect(nicknameError("🎵".repeat(80))).toBeNull();
    expect(nicknameError("  Bar  ")).toBeNull();
    expect(friendlyError({ message: "secret SQL detail" })).not.toContain(
      "secret",
    );
    expect(friendlyError({ code: "23514" })).toContain("1–80");
  });
});
