import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "./auth";
import { uuidPattern, type Choice, type Home, type Pick } from "./api";
import { Artwork, musicURL, rejected } from "./Rating";
import {
  confirmPending,
  readPending,
  removePending,
  savePending,
  type PendingVote,
} from "./pendingVotes";

const choices: Choice[] = ["PASS", "LIKE", "SUPER_LIKE"];
const labels = { PASS: "PASS", LIKE: "LIKE", SUPER_LIKE: "SUPER LIKE" };
export function MyPicks() {
  const { seasonId = "" } = useParams();
  const { identity } = useAuth();
  return (
    <PicksSession key={`${identity!.id}:${seasonId}`} seasonId={seasonId} />
  );
}
function PicksSession({ seasonId }: { seasonId: string }) {
  const { api, identity } = useAuth();
  const user = identity!.id;
  const [home, setHome] = useState<Home | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [pending, setPending] = useState<PendingVote | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Choice | "ALL">("ALL");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
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
      const currentHome = await api.home(seasonId, user);
      if (!currentHome) throw new Error("Season unavailable");
      const currentPicks = await api.myPicks(seasonId, user);
      if (!active) return;
      setHome(currentHome);
      setPicks(currentPicks);
      setPending(saved);
      setReady(true);
    }
    load().catch(() => {
      if (active)
        setMessage(
          "We couldn’t load your picks or pending action. Check your connection and browser storage, then refresh.",
        );
    });
    return () => {
      active = false;
    };
  }, [api, seasonId, user, attempt]);
  useEffect(() => {
    const refresh = () => {
      if (!submitting.current) setAttempt((n) => n + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function edit(pick?: Pick, choice?: Choice) {
    if (submitting.current || !ready) return;
    if (
      !pending &&
      (!pick ||
        !choice ||
        pick.choice === choice ||
        !pick.active ||
        home?.season.state !== "VOTING")
    )
      return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    let saved: PendingVote;
    try {
      // Another screen/tab may already have an uncertain action. Reconcile it first.
      saved = pending ??
        readPending(user, seasonId) ?? {
          action: {
            user_id: user,
            season_id: seasonId,
            track_id: pick!.id,
            choice: choice!,
            expected_version: pick!.version,
            action_id: crypto.randomUUID(),
          },
          track: pick!,
        };
      savePending(saved);
      setPending(saved);
    } catch {
      setMessage(
        "Your browser couldn’t save the pending edit. Enable site storage and try again. No new vote was sent.",
      );
      submitting.current = false;
      setBusy(false);
      return;
    }
    try {
      await confirmPending(api, saved);
      if (!mounted.current) return;
      setPending(null);
      setReady(false);
      setMessage("Vote saved.");
      setAttempt((n) => n + 1);
      // Always reread current votes: an idempotent receipt may predate another device's edit.
    } catch (error) {
      if (!mounted.current) return;
      const code =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "";
      if (rejected[code]) {
        try {
          removePending(saved.action);
          setPending(null);
          setReady(false);
          setMessage(
            code === "vote_version_conflict"
              ? "This vote changed in another session. We’re reloading your latest choice. Review it before making another edit."
              : rejected[code],
          );
          setAttempt((n) => n + 1);
        } catch {
          setMessage(
            "Couldn’t clear the pending action. Restore browser storage and retry safely.",
          );
        }
      } else {
        setMessage(
          "We couldn’t confirm this edit. Retry the same action safely. If your session expired, sign in again with the same account.",
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const query = search.trim().toLocaleLowerCase();
  const visible = picks.filter(
    (p) =>
      (filter === "ALL" || p.choice === filter) &&
      [p.title, ...p.artists].some((text) =>
        text.toLocaleLowerCase().includes(query),
      ),
  );
  const closed = home?.season.state !== "VOTING";
  return (
    <section className="picks">
      <Link className="back-link" to={`/seasons/${seasonId}`}>
        ← Season home
      </Link>
      <p className="eyebrow">{home?.season.name ?? "Your season"}</p>
      <h1>My Picks</h1>
      <p>Your choices, visible only to you.</p>
      {home && (
        <p>{home.progress.super_likes_available} Super Likes remaining</p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <button disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
        Refresh picks
      </button>
      {!ready ? (
        <p>Loading your latest choices…</p>
      ) : (
        <>
          {closed && (
            <p role="status" className="notice">
              Voting is closed or hasn’t opened yet. You can still view your
              choices.
            </p>
          )}
          {pending && (
            <aside className="entry-card" aria-label="Pending vote">
              <p>
                Awaiting confirmation: {pending.track.title} →{" "}
                {labels[pending.action.choice]}
              </p>
              <button disabled={busy} onClick={() => void edit()}>
                {busy ? "Saving vote…" : "Retry pending vote"}
              </button>
            </aside>
          )}
          <div className="picks-controls">
            <label htmlFor="picks-search">Search title or artist</label>
            <input
              id="picks-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label htmlFor="picks-filter">Filter choices</label>
            <select
              id="picks-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Choice | "ALL")}
            >
              <option value="ALL">All</option>
              <option value="LIKE">Likes</option>
              <option value="SUPER_LIKE">Super Likes</option>
              <option value="PASS">Passes</option>
            </select>
          </div>
          {!picks.length ? (
            <p>No picks yet. Rate your first track to see it here.</p>
          ) : !visible.length ? (
            <p>No choices match your search or filter.</p>
          ) : (
            <ul className="picks-list">
              {visible.map((p) => {
                const spotify = musicURL(p.spotify_url, "spotify");
                const apple = musicURL(p.apple_music_url, "apple");
                return (
                  <li key={p.id}>
                    <article aria-label={p.title} className="pick-card">
                      <Artwork key={p.id} track={p} />
                      <div>
                        <h2>{p.title}</h2>
                        <p>{p.artists.join(" & ") || "Artist unavailable"}</p>
                        <p>
                          Current choice: <strong>{labels[p.choice]}</strong>
                        </p>
                        {!p.active && (
                          <p className="fine">
                            No longer active in this season. Your choice is
                            preserved.
                          </p>
                        )}
                        <div className="music-actions">
                          {spotify ? (
                            <a
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
                        <div
                          className="pick-actions"
                          aria-label={`Edit ${p.title}`}
                        >
                          {choices.map((c) => (
                            <button
                              key={c}
                              aria-pressed={p.choice === c}
                              disabled={
                                busy ||
                                !!pending ||
                                closed ||
                                !p.active ||
                                p.choice === c
                              }
                              onClick={() => void edit(p, c)}
                            >
                              {labels[c]}
                            </button>
                          ))}
                        </div>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
