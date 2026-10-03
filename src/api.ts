import { createClient } from "@supabase/supabase-js";

export type Identity = { id: string; email?: string };
export type Season = {
  id: string;
  name: string;
  year: number;
  state: "SETUP" | "VOTING" | "LOCKED" | "REVEAL";
};
export type Membership = { season_id: string; nickname: string };
export type Invitation = {
  season_id: string;
  season_name: string;
  year: number;
  nickname: string | null;
};
export type Progress = {
  active_tracks: number;
  rated: number;
  unrated: number;
  super_likes_used: number;
  super_likes_available: number;
  completion_percent: number | null;
};
export type Home = { season: Season; nickname: string; progress: Progress };
export interface API {
  restore(): Promise<Identity | null>;
  subscribe(listener: (identity: Identity | null) => void): () => void;
  signIn(): Promise<void>;
  complete(code: string): Promise<Identity>;
  signOut(): Promise<void>;
  memberships(userId: string): Promise<Membership[]>;
  inspect(token: string): Promise<Invitation>;
  accept(token: string, nickname: string): Promise<string>;
  home(seasonId: string, userId: string): Promise<Home | null>;
}

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function nicknameError(nickname: string): string | null {
  // PostgreSQL counts Unicode code points; use the same count instead of UTF-16 length.
  if (!nickname.trim()) return "Choose a rave name to continue.";
  if (Array.from(nickname.trim()).length > 80)
    return "Keep your rave name to 80 characters or fewer.";
  return null;
}
export function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  if (
    "message" in error &&
    typeof error.message === "string" &&
    [
      "invitation_not_available",
      "verified_google_identity_required",
      "authentication_required",
    ].includes(error.message)
  )
    return error.message;
  return "code" in error && typeof error.code === "string" ? error.code : "";
}
export function friendlyError(error: unknown): string {
  switch (errorCode(error)) {
    case "invitation_not_available":
      return "This invitation is unavailable or was sent to a different Google account.";
    case "verified_google_identity_required":
      return "Sign in with the verified Google account that received your invitation.";
    case "authentication_required":
    case "PGRST301":
    case "PGRST303":
      return "Your session has expired. Please sign in again.";
    case "23505":
      return "That rave name could not be saved. Please try another name.";
    case "23514":
      return "Check your rave name and try again. Use 1–80 characters.";
    default:
      return "We couldn’t complete that request. Please try again.";
  }
}

export function createAPI(url: string, key: string): API {
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !key ||
    key.includes("your-public") ||
    key.startsWith("sb_secret_")
  )
    throw new Error("Invalid public configuration");
  // Reject legacy privileged JWT keys too. This is accidental-secret prevention, not authorization.
  if (key.startsWith("eyJ")) {
    const payload = JSON.parse(
      atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (payload.role !== "anon")
      throw new Error("A public anon key is required");
  }
  const client = createClient(url, key, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  let exchange: { code: string; promise: Promise<Identity> } | undefined;
  return {
    async restore() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session?.user ?? null;
    },
    subscribe(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) =>
        listener(session?.user ?? null),
      );
      return () => data.subscription.unsubscribe();
    },
    async signIn() {
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
    },
    complete(code) {
      // StrictMode/remounts must not consume a single-use PKCE code twice.
      if (exchange?.code === code) return exchange.promise;
      const promise = client.auth
        .exchangeCodeForSession(code)
        .then(({ data, error }) => {
          if (error || !data.user) throw error ?? new Error("No session");
          return data.user;
        });
      exchange = { code, promise };
      return promise;
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
    },
    async memberships(userId) {
      // Explicit own-user filter also prevents application admins fetching the whole member list.
      const { data, error } = await client
        .from("season_members")
        .select("season_id,nickname")
        .eq("user_id", userId)
        .order("joined_at", { ascending: false });
      if (error) throw error;
      return data as Membership[];
    },
    async inspect(token) {
      const { data, error } = await client.rpc("inspect_invitation", {
        p_invitation: token,
      });
      if (error) throw error;
      return data as Invitation;
    },
    async accept(token, nickname) {
      const { data, error } = await client.rpc("accept_invitation", {
        p_invitation: token,
        p_nickname: nickname,
      });
      if (error) throw error;
      return data as string;
    },
    async home(seasonId, userId) {
      const [season, member, progress] = await Promise.all([
        client
          .from("seasons")
          .select("id,name,year,state")
          .eq("id", seasonId)
          .maybeSingle(),
        client
          .from("season_members")
          .select("nickname")
          .eq("season_id", seasonId)
          .eq("user_id", userId)
          .maybeSingle(),
        client.rpc("my_progress", { p_season: seasonId }),
      ]);
      if (season.error) throw season.error;
      if (member.error) throw member.error;
      if (!season.data || !member.data) return null;
      if (progress.error) throw progress.error;
      return {
        season: season.data as Season,
        nickname: member.data.nickname,
        progress: progress.data as Progress,
      };
    },
  };
}
