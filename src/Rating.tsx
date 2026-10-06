import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "./auth";
import { uuidPattern, type Choice, type Home, type Track } from "./api";
import {
  readPending,
  removePending,
  savePending,
  type PendingVote,
} from "./pendingVotes";

export function musicURL(
  value: string | null,
  provider: "spotify" | "apple",
): string | null {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.hostname ===
      (provider === "spotify" ? "open.spotify.com" : "music.apple.com")
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function Artwork({ track }: { track: Track }) {
  const [failed, setFailed] = useState(false);
  let url: URL | undefined;
  try {
    url = new URL(track.artwork_url ?? "");
  } catch {
    /* Use local placeholder. */
  }
  return !failed && url?.protocol === "https:" ? (
    <img
      className="track-art"
      src={url.href}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <div
      className="track-art placeholder"
      role="img"
      aria-label="Track artwork placeholder"
    >
      <span>HS / 26</span>
      <span aria-hidden="true">↗</span>
    </div>
  );
}
const rejected: Record<string, string> = {
  super_like_limit:
    "You’ve used all your Super Likes. Choose PASS or LIKE instead.",
  voting_closed:
    "Voting is closed or hasn’t opened yet. This vote wasn’t saved.",
  vote_version_conflict:
    "This track was already rated in another session. Your existing vote wasn’t changed.",
  action_payload_conflict:
    "This action ID was already used for a different vote. This request wasn’t applied; refresh before continuing.",
  track_not_active: "This track is no longer available for voting.",
  season_membership_required:
    "This season is no longer available to your account.",
};
export function Rating() {
  const { seasonId = "" } = useParams();
  const { identity } = useAuth();
  return (
    <RatingSession key={`${identity!.id}:${seasonId}`} seasonId={seasonId} />
  );
}
function RatingSession({ seasonId }: { seasonId: string }) {
  const { api, identity } = useAuth();
  const user = identity!.id;
  const [home, setHome] = useState<Home | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [pending, setPending] = useState<PendingVote | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setReady(false);
    async function load() {
      if (!uuidPattern.test(seasonId)) throw new Error("Invalid season");
      const saved = readPending(user, seasonId);
      const nextHome = await api.home(seasonId, user);
      if (!nextHome) throw new Error("Unavailable season");
      const next = saved?.track ?? (await api.nextTrack(seasonId));
      if (!active) return;
      setHome(nextHome);
      setTrack(next);
      setPending(saved);
      setReady(true);
      if (saved)
        setMessage(
          "A vote is awaiting confirmation. Retry it safely before continuing.",
        );
    }
    load().catch(() => {
      if (active)
        setMessage(
          "We couldn’t load your rating session or pending vote. Check your connection and browser storage, then try again.",
        );
    });
    return () => {
      active = false;
    };
  }, [api, seasonId, user, attempt]);

  async function submit(choice?: Choice) {
    if (
      submitting.current ||
      !ready ||
      !track ||
      (!pending && home?.season.state !== "VOTING")
    )
      return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    let actionPending: PendingVote;
    try {
      // Recover another tab's outstanding action before creating any new one.
      actionPending = pending ??
        readPending(user, seasonId) ?? {
          action: {
            user_id: user,
            season_id: seasonId,
            track_id: track.id,
            choice: choice!,
            expected_version: 0,
            action_id: crypto.randomUUID(),
          },
          track,
        };
      savePending(actionPending); // Fail closed if durable browser storage is unavailable.
      setPending(actionPending);
      setTrack(actionPending.track);
    } catch {
      setMessage(
        "Your browser couldn’t save the pending vote. Enable site storage and try again. No new vote was sent.",
      );
      submitting.current = false;
      setBusy(false);
      return;
    }
    try {
      const a = actionPending.action;
      const receipt = await api.castVote(a);
      if (
        receipt.action_id !== a.action_id ||
        receipt.season_id !== a.season_id ||
        receipt.track_id !== a.track_id ||
        receipt.choice !== a.choice ||
        receipt.version !== 1
      )
        throw new Error("Unexpected vote receipt");
      removePending(a);
      if (!mounted.current) return;
      setPending(null);
      setReady(false);
      setTrack(null);
      setMessage("Vote saved.");
      setAttempt((n) => n + 1);
    } catch (error) {
      if (!mounted.current) return;
      const code =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "";
      if (rejected[code]) {
        try {
          removePending(actionPending.action);
          setPending(null);
          setReady(false);
          setTrack(null);
          setMessage(rejected[code]);
          // A fresh backend read reconciles other-device votes, allowance, and season state.
          setAttempt((n) => n + 1);
        } catch {
          setMessage(
            "Couldn’t clear the pending action. Restore browser storage and retry safely.",
          );
        }
      } else {
        setMessage(
          "We couldn’t confirm this vote. Retry the same action safely—even if it already reached the server. You can also sign in again if your session expired.",
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const spotify = musicURL(track?.spotify_url ?? null, "spotify");
  const apple = musicURL(track?.apple_music_url ?? null, "apple");
  const closed = home?.season.state !== "VOTING";
  return (
    <section className="rating">
      <Link to={`/seasons/${seasonId}`} className="back-link">
        ← Season home
      </Link>
      <p className="eyebrow">{home?.season.name ?? "Your season"}</p>
      {home && (
        <p className="rating-progress">
          {home.progress.rated} / {home.progress.active_tracks} rated ·{" "}
          {home.progress.super_likes_available} Super Likes remaining
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {!ready ? (
        <>
          <p>Loading your latest progress…</p>
          <button disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </>
      ) : closed && !pending ? (
        <>
          <h1>
            {home?.season.state === "SETUP"
              ? "Getting ready."
              : "Voting is closed."}
          </h1>
          <p>Your saved votes stay safe. Check back with your season admin.</p>
        </>
      ) : !track ? (
        <>
          <h1>You’re caught up.</h1>
          <p>
            You’ve rated every track currently available. New releases may still
            appear.
          </p>
          <button onClick={() => setAttempt((n) => n + 1)}>
            Check for new tracks
          </button>
        </>
      ) : (
        <>
          <Artwork key={track.id} track={track} />
          <h1 className="track-title">{track.title}</h1>
          <p className="track-artists">
            {track.artists.join(" & ") || "Artist unavailable"}
          </p>
          <div className="music-actions">
            {spotify ? (
              <a
                className="button"
                href={spotify}
                target="_blank"
                rel="noopener noreferrer"
              >
                Spotify ↗
              </a>
            ) : (
              <span>Spotify unavailable</span>
            )}
            {apple ? (
              <a
                className="button"
                href={apple}
                target="_blank"
                rel="noopener noreferrer"
              >
                Apple Music ↗
              </a>
            ) : (
              <span>Apple Music unavailable</span>
            )}
          </div>
          {pending ? (
            <div>
              <p>Pending: {pending.action.choice.replace("_", " ")}</p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "Saving vote…" : "Retry pending vote"}
              </button>
            </div>
          ) : (
            <div className="vote-actions">
              <button
                disabled={busy || closed}
                onClick={() => void submit("PASS")}
              >
                ← PASS
              </button>
              <button
                className="like"
                disabled={busy || closed}
                onClick={() => void submit("LIKE")}
              >
                LIKE →
              </button>
              <button
                className="super"
                disabled={busy || closed}
                onClick={() => void submit("SUPER_LIKE")}
              >
                ↑ SUPER LIKE
              </button>
            </div>
          )}
          <p className="fine">
            Your choice is saved before the next track appears.
          </p>
        </>
      )}
    </section>
  );
}
