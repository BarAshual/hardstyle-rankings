import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "./auth";
import { uuidPattern, type Choice, type Home, type Track } from "./api";
import { MusicLinks } from "./MusicLinks";
import { SwipeCard } from "./SwipeCard";
import { EXIT_MS } from "./swipe";
import { rejected } from "./voteErrors";
import {
  confirmPending,
  readPending,
  removePending,
  savePending,
  type PendingVote,
} from "./pendingVotes";
export { musicURL } from "./MusicLinks";

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
  const [readError, setReadError] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [exit, setExit] = useState<Choice | null>(null);
  const [entering, setEntering] = useState(false);
  const [allowUp, setAllowUp] = useState(false);
  const departure = useRef<Choice | null>(null);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveExit = () => {};
    const leaving = departure.current;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    departure.current = null;
    setReadError(false);
    // Start the ordinary authoritative reads only after receipt confirmation.
    // Keep the outgoing card for the exit; a slow read then waits in the same slot.
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
      if (!leaving) {
        resolve();
        return;
      }
      timer = setTimeout(
        () => {
          if (active) {
            setTrack(null);
            setExit(null);
          }
          resolve();
        },
        reduced ? 0 : EXIT_MS,
      );
    });
    async function load() {
      if (!uuidPattern.test(seasonId)) throw new Error("Invalid season");
      const saved = readPending(user, seasonId);
      const nextHome = await api.home(seasonId, user);
      if (!nextHome) throw new Error("Unavailable season");
      const next = saved?.track ?? (await api.nextTrack(seasonId));
      await exited;
      if (!active) return;
      setHome(nextHome);
      setTrack(next);
      setPending(saved);
      setExit(null);
      setEntering(!!leaving && !!next && !reduced);
      setReady(true);
      if (saved) {
        setSuccess(false);
        setMessage(
          "A vote is awaiting confirmation. Retry it safely before continuing.",
        );
      }
    }
    load().catch(async () => {
      await exited;
      if (active) {
        setTrack(null);
        setReadError(true);
        setSuccess(false);
        setMessage(
          "We couldn’t load your rating session or pending vote. Check your connection and browser storage, then try again.",
        );
      }
    });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      resolveExit();
    };
  }, [api, seasonId, user, attempt]);

  useLayoutEffect(() => {
    // Native vertical scrolling takes priority whenever the page exceeds the visible viewport.
    const measure = () => {
      const height = Math.min(
        window.innerHeight,
        window.visualViewport?.height ?? window.innerHeight,
      );
      setAllowUp(document.documentElement.scrollHeight <= height + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(document.body);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  function refresh() {
    if (submitting.current) return;
    setReady(false);
    setTrack(null);
    setReadError(false);
    setAttempt((n) => n + 1);
  }
  async function submit(choice?: Choice): Promise<boolean> {
    if (
      submitting.current ||
      !ready ||
      !track ||
      (choice && pending) ||
      (!pending && home?.season.state !== "VOTING")
    )
      return false;
    if (
      !pending &&
      choice === "SUPER_LIKE" &&
      home?.progress.super_likes_available === 0
    ) {
      setSuccess(false);
      setMessage(rejected.super_like_limit);
      return false;
    }
    submitting.current = true; // Synchronous guard covers repeated release/click events.
    setBusy(true);
    setSuccess(false);
    setMessage("Saving your choice…");
    let actionPending: PendingVote;
    try {
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
      savePending(actionPending); // Journal before network, fail closed on storage failure.
      setPending(actionPending);
      setTrack(actionPending.track);
    } catch {
      setMessage(
        "Your browser couldn’t save the pending vote. Enable site storage and try again. No new vote was sent.",
      );
      submitting.current = false;
      setBusy(false);
      return false;
    }
    try {
      await confirmPending(api, actionPending);
      if (!mounted.current) return false;
      setPending(null);
      setReady(false);
      setSuccess(true);
      setMessage("Vote saved. Loading the next track.");
      departure.current = actionPending.action.choice;
      setExit(actionPending.action.choice);
      setAttempt((n) => n + 1);
      return true;
    } catch (error) {
      if (!mounted.current) return false;
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
          setAttempt((n) => n + 1); // Reconcile authoritative state; never overwrite a conflict.
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
      return false;
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const closed = home?.season.state !== "VOTING";
  const enabled = ready && !!track && !busy && !pending && !closed;
  const terminal = ready && !pending && (closed || !track);
  return (
    <section className="rating">
      <div className="rating-context">
        <Link to={`/seasons/${seasonId}`} className="back-link">
          ← Season home
        </Link>
        <p className="eyebrow">{home?.season.name ?? "Your season"}</p>
      </div>
      <p className="rating-progress">
        {home
          ? `${home.progress.rated} / ${home.progress.active_tracks} rated · ${home.progress.super_likes_available} Super Likes remaining`
          : "Loading your latest progress…"}
      </p>
      <div className="rating-stage" aria-busy={busy || !ready}>
        {terminal ? (
          <div className="rating-stage-message">
            <h1>
              {closed
                ? home?.season.state === "SETUP"
                  ? "Getting ready."
                  : "Voting is closed."
                : "You’re caught up."}
            </h1>
            <p>
              {closed
                ? "Your saved votes stay safe. Check back with your season admin."
                : "You’ve rated every track currently available. New releases may still appear."}
            </p>
            {!closed && <button onClick={refresh}>Check for new tracks</button>}
          </div>
        ) : track ? (
          <SwipeCard
            key={track.id}
            track={track}
            enabled={enabled}
            allowUp={allowUp}
            saving={busy}
            exit={exit}
            entering={entering}
            onEntered={() => setEntering(false)}
            onChoice={submit}
          />
        ) : (
          <div className="rating-stage-message">
            <p>
              {readError
                ? "The next track is unavailable right now."
                : "Loading your next track…"}
            </p>
            {readError && <button onClick={refresh}>Try again</button>}
          </div>
        )}
      </div>
      <div className="rating-track-copy">
        {track && (
          <>
            <h1 className="track-title">{track.title}</h1>
            <p className="track-artists">
              {track.artists.join(" & ") || "Artist unavailable"}
            </p>
          </>
        )}
      </div>
      <MusicLinks track={track} />
      <div className="vote-actions">
        <button disabled={!enabled} onClick={() => void submit("PASS")}>
          ← PASS
        </button>
        <button
          className="like"
          disabled={!enabled}
          onClick={() => void submit("LIKE")}
        >
          LIKE →
        </button>
        <button
          className="super"
          disabled={!enabled || home?.progress.super_likes_available === 0}
          onClick={() => void submit("SUPER_LIKE")}
        >
          ↑ SUPER LIKE
        </button>
      </div>
      <p id="swipe-hint" className="swipe-hint">
        {allowUp
          ? "Swipe ← Pass · Like → · ↑ Super Like"
          : "Swipe ← or → · Super Like with the button"}
      </p>
      <div className="rating-message-slot">
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={success || busy || !message ? "sr-only" : "rating-message"}
        >
          {message}
        </p>
      </div>
      <div className="rating-recovery">
        {pending && (
          <>
            <p className="fine">
              Pending: {pending.action.choice.replace("_", " ")}
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "Saving vote…" : "Retry pending vote"}
            </button>
          </>
        )}
      </div>
      <p className="fine rating-save-note">
        Your choice is saved before the next track appears.
      </p>
    </section>
  );
}
