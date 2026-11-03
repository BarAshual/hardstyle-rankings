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
export type AdminProgressRow = {
  user_id: string; nickname: string; role: "member" | "admin";
  active_tracks: number; rated: number; unrated: number; completion_percent: number | null;
};
export type Home = {
  season: Season;
  nickname: string;
  role: "member" | "admin";
  progress: Progress;
};
export type AdminSeason = {
  seasonId: string;
  name: string;
  category: "love_similarity";
  state: Season["state"];
  visible: boolean;
  canChange: boolean;
};
export type AdminMember = {
  user_id: string;
  email: string | null;
  nickname: string;
  role: "member" | "admin";
  active_tracks: number;
  rated: number;
  unrated: number;
  completion_percent: number | null;
  super_likes_used: number;
  super_likes_available: number;
};
export type AdminInvitation = {
  id: string;
  email: string;
  created_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
};
export type ImportContext = { [key: string]: unknown };
export type VisibilityAction = {
  kind: "visibility";
  userId: string;
  seasonId: string;
  actionId: string;
  visible: boolean;
};
export type Choice = "PASS" | "LIKE" | "SUPER_LIKE";
export type Track = {
  id: string;
  title: string;
  artists: string[];
  artwork_url: string | null;
  spotify_url: string | null;
  apple_music_url: string | null;
};
export type Pick = Track & { choice: Choice; version: number; active: boolean };
export type VoteAction = {
  user_id: string;
  season_id: string;
  track_id: string;
  choice: Choice;
  expected_version: number;
  action_id: string;
};
export type VoteReceipt = {
  action_id: string;
  season_id: string;
  track_id: string;
  choice: Choice;
  version: number;
  accepted_at: string;
};
export interface API {
  adminSeason(seasonId: string, userId: string): Promise<AdminSeason>;
  setLoveVisibility(action: VisibilityAction): Promise<unknown>;
  adminMembers?(seasonId: string, userId: string): Promise<AdminMember[]>;
  adminInvitations?(seasonId: string, userId: string): Promise<AdminInvitation[]>;
  inviteMember?(seasonId: string, userId: string, email: string): Promise<string>;
  setMemberRole?(seasonId: string, userId: string, memberId: string, role: "member" | "admin"): Promise<unknown>;
  increaseAllowance?(seasonId: string, userId: string, allowance: number, reason: string): Promise<unknown>;
  adminProgress?(seasonId: string, userId: string): Promise<AdminProgressRow[]>;
  importContext?(seasonId: string, userId: string): Promise<ImportContext>;
  designateImportSource?(seasonId: string, userId: string, sourceId: string, market: string, reason: string): Promise<ImportContext>;
  transitionSeason(
    seasonId: string,
    userId: string,
    state: Season["state"],
  ): Promise<unknown>;
  myPicks(seasonId: string, userId: string): Promise<Pick[]>;
  nextTrack(seasonId: string): Promise<Track | null>;
  castVote(action: VoteAction): Promise<VoteReceipt>;
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
      "nickname_unavailable",
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
    case "nickname_unavailable":
    case "23505":
      return "That rave name is already taken in this season. Please try another name.";
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
  async function adminToken(userId: string) {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (!data.session || data.session.user.id !== userId)
      throw new Error("authentication_required");
    return `Bearer ${data.session.access_token}`;
  }
  return {
    async adminSeason(seasonId, userId) {
      const token = await adminToken(userId);
      // This RPC authorizes the current season's admin. No results/progress or
      // other members' records are fetched by the panel.
      const { data, error } = await client
        .rpc("get_love_similarity_visibility", {
          p_season: seasonId,
        })
        .setHeader("Authorization", token)
        .abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      const season = await client
        .from("seasons")
        .select("name")
        .eq("id", seasonId)
        .setHeader("Authorization", token)
        .abortSignal(AbortSignal.timeout(30000))
        .maybeSingle();
      if (season.error) throw season.error;
      if (!season.data) throw new Error("season_admin_required");
      return { ...data, name: season.data.name } as AdminSeason;
    },
    async setLoveVisibility(action) {
      const token = await adminToken(action.userId);
      const { data, error } = await client
        .rpc("set_love_similarity_visibility", {
          p_season: action.seasonId,
          p_visible: action.visible,
          p_action: action.actionId,
        })
        .setHeader("Authorization", token)
        .abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return data;
    },
    async adminMembers(seasonId, userId) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("admin_members", { p_season: seasonId })
        .setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) {
        // Keep the operational panel useful if the optional aggregate view is
        // unavailable during a staged migration. RLS still limits this
        // fallback to members of the selected season.
        const fallback = await client
          .from("season_members")
          .select("user_id,nickname,role")
          .eq("season_id", seasonId)
          .setHeader("Authorization", token)
          .abortSignal(AbortSignal.timeout(30000));
        if (fallback.error) throw error;
        return (fallback.data ?? []).map((member) => ({
          ...member,
          email: "",
          active_tracks: 0,
          rated: 0,
          unrated: 0,
          completion_percent: null,
          super_likes_used: 0,
          super_likes_available: 0,
        })) as AdminMember[];
      }
      return (data ?? []) as AdminMember[];
    },
    async adminInvitations(seasonId, userId) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("admin_invitations", { p_season: seasonId })
        .setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return (data ?? []) as AdminInvitation[];
    },
    async inviteMember(seasonId, userId, email) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("invite_member", { p_season: seasonId, p_email: email })
        .setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return data as string;
    },
    async setMemberRole(seasonId, userId, memberId, role) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("set_member_role", {
        p_season: seasonId, p_user: memberId, p_role: role,
      }).setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return data;
    },
    async increaseAllowance(seasonId, userId, allowance, reason) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("increase_allowance", {
        p_season: seasonId, p_allowance: allowance, p_reason: reason,
      }).setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return data;
    },
    async adminProgress(seasonId, userId) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("admin_progress", { p_season: seasonId })
        .setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return (data ?? []) as AdminProgressRow[];
    },
    async importContext(seasonId, userId) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("import_context", { p_season: seasonId })
        .setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return (data ?? {}) as ImportContext;
    },
    async designateImportSource(seasonId, userId, sourceId, market, reason) {
      const token = await adminToken(userId);
      const { data, error } = await client.rpc("designate_import_source", {
        p_season: seasonId, p_source: sourceId, p_market: market, p_reason: reason,
      }).setHeader("Authorization", token).abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return (data ?? {}) as ImportContext;
    },
    async transitionSeason(seasonId, userId, state) {
      const token = await adminToken(userId);
      const { data, error } = await client
        .rpc("transition_season", {
          p_season: seasonId,
          p_state: state,
        })
        .setHeader("Authorization", token)
        .abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return data;
    },
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
    async myPicks(seasonId, userId) {
      const picks: Pick[] = [];
      let after: string | undefined;
      // Keyset pagination avoids the Data API row cap, with RLS plus an explicit own-user filter.
      for (;;) {
        let query = client
          .from("votes")
          .select(
            "track_id,choice,version,catalog:season_tracks!inner(active,track:tracks!inner(id,title,artwork_url,spotify_url,apple_music_url,credits:track_artists(credit_order,artist:artists(name))))",
          )
          .eq("season_id", seasonId)
          .eq("user_id", userId)
          .order("track_id")
          .limit(500);
        if (after) query = query.gt("track_id", after);
        const { data, error } = await query;
        if (error) throw error;
        const rows = data as unknown as Array<{
          track_id: string;
          choice: Choice;
          version: number;
          catalog: {
            active: boolean;
            track: Omit<Track, "artists"> & {
              credits: Array<{
                credit_order: number;
                artist: { name: string };
              }>;
            };
          };
        }>;
        for (const row of rows) {
          const { credits, ...track } = row.catalog.track;
          picks.push({
            ...track,
            choice: row.choice,
            version: row.version,
            active: row.catalog.active,
            artists: [...credits]
              .sort((a, b) => a.credit_order - b.credit_order)
              .map((c) => c.artist.name),
          });
        }
        if (rows.length < 500) break;
        after = rows[rows.length - 1].track_id;
      }
      return picks;
    },
    async nextTrack(seasonId) {
      const { data, error } = await client.rpc("next_unrated_track", {
        p_season: seasonId,
      });
      if (error) throw error;
      return data as Track | null;
    },
    async castVote(action) {
      const { data: session, error: sessionError } =
        await client.auth.getSession();
      if (sessionError) throw sessionError;
      if (session.session?.user.id !== action.user_id)
        throw new Error("authentication_required");
      const { data, error } = await client
        .rpc("cast_vote", {
          p_season: action.season_id,
          p_track: action.track_id,
          p_choice: action.choice,
          p_expected_version: action.expected_version,
          p_action: action.action_id,
        })
        .setHeader("Authorization", `Bearer ${session.session.access_token}`)
        .abortSignal(AbortSignal.timeout(30000));
      if (error) throw error;
      return data as VoteReceipt;
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
          .select("nickname,role")
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
        role: member.data.role,
        progress: progress.data as Progress,
      };
    },
  };
}
