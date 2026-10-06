import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  oauth: vi.fn(),
  create: vi.fn(),
  rpc: vi.fn(),
  session: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
import { createAPI, friendlyError, nicknameError } from "../../src/api";
beforeEach(() => {
  mocks.create.mockReturnValue({
    rpc: mocks.rpc,
    from: mocks.from,
    auth: {
      exchangeCodeForSession: mocks.exchange,
      signInWithOAuth: mocks.oauth,
      getSession: mocks.session,
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

it("sends the exact first-vote payload with the captured actor token", async () => {
  const result = { data: { version: 1 }, error: null };
  const abortSignal = vi.fn().mockResolvedValue(result);
  const setHeader = vi.fn().mockReturnValue({ abortSignal });
  mocks.rpc.mockReturnValue({ setHeader });
  mocks.session.mockResolvedValue({
    data: { session: { user: { id: "actor" }, access_token: "test-token" } },
    error: null,
  });
  const api = createAPI("http://127.0.0.1:54321", "sb_publishable_test");
  const action = {
    user_id: "actor",
    season_id: "season",
    track_id: "track",
    choice: "LIKE" as const,
    expected_version: 0 as const,
    action_id: "action",
  };
  await api.castVote(action);
  expect(mocks.rpc).toHaveBeenCalledWith("cast_vote", {
    p_season: "season",
    p_track: "track",
    p_choice: "LIKE",
    p_expected_version: 0,
    p_action: "action",
  });
  expect(setHeader).toHaveBeenCalledWith("Authorization", "Bearer test-token");
  mocks.session.mockResolvedValue({
    data: {
      session: { user: { id: "different-user" }, access_token: "other" },
    },
    error: null,
  });
  await expect(api.castVote(action)).rejects.toThrow("authentication_required");
  expect(mocks.rpc).toHaveBeenCalledOnce();
});

it("reads every page of own picks with ordered credits and a stable cursor", async () => {
  const row = (n: number) => ({
    track_id: `track-${n}`,
    choice: "LIKE",
    version: 4,
    catalog: {
      active: true,
      track: {
        id: `track-${n}`,
        title: "Fixture",
        artwork_url: null,
        spotify_url: null,
        apple_music_url: null,
        credits: [
          { credit_order: 1, artist: { name: "Second" } },
          { credit_order: 0, artist: { name: "First" } },
        ],
      },
    },
  });
  let page = 0;
  const pages = [Array.from({ length: 500 }, (_, i) => row(i)), [row(500)]];
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => void) =>
      Promise.resolve({ data: pages[page++], error: null }).then(resolve),
  };
  mocks.from.mockReturnValue(query);
  const result = await createAPI(
    "http://127.0.0.1:54321",
    "sb_publishable_test",
  ).myPicks("season", "actor");
  expect(mocks.from).toHaveBeenCalledWith("votes");
  expect(query.eq).toHaveBeenCalledWith("season_id", "season");
  expect(query.eq).toHaveBeenCalledWith("user_id", "actor");
  expect(query.gt).toHaveBeenCalledWith("track_id", "track-499");
  expect(result).toHaveLength(501);
  expect(result[500]).toMatchObject({
    version: 4,
    artists: ["First", "Second"],
  });
});
