import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { uuidPattern, type Choice, type Home, type Pick } from "./api";
import { rejected } from "./voteErrors";
import { Artwork } from "./Artwork";
import { MusicLinks } from "./MusicLinks";
import {
  confirmPending,
  readPending,
  removePending,
  savePending,
  type PendingVote,
} from "./pendingVotes";

const choices: Choice[] = ["PASS", "SUPER_LIKE", "LIKE"];
const labels = { PASS: "PASS", LIKE: "LIKE", SUPER_LIKE: "SUPER LIKE" };
const pageSize = 25;

function PicksPagination({
  page,
  pages,
  position,
  onPage,
}: {
  page: number;
  pages: number;
  position: "top" | "bottom";
  onPage: (page: number) => void;
}) {
  return (
    <nav
      className="picks-pagination"
      aria-label={`My Picks pages (${position})`}
    >
      <button
        disabled={page === 1}
        aria-controls="picks-list"
        onClick={() => onPage(page - 1)}
      >
        ← Previous
      </button>
      <span aria-current="page">
        Page {page} of {pages}
      </span>
      <button
        disabled={page === pages}
        aria-controls="picks-list"
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </nav>
  );
}
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
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const filterValue = searchParams.get("choice");
  const filter: Choice | "ALL" = choices.includes(filterValue as Choice)
    ? (filterValue as Choice)
    : "ALL";
  const pageValue = Number(searchParams.get("page") ?? "1");
  const requestedPage =
    Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  const mounted = useRef(false);
  const refreshInFlight = useRef(true);
  const resultsSummary = useRef<HTMLParagraphElement>(null);
  const scrollToResults = useRef(false);
  const scheduleRefresh = useCallback(() => {
    refreshInFlight.current = true;
    setRefreshing(true);
    setAttempt((n) => n + 1);
  }, []);
  const refresh = useCallback(() => {
    if (!submitting.current && !refreshInFlight.current) scheduleRefresh();
  }, [scheduleRefresh]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    refreshInFlight.current = true;
    setRefreshing(true);
    setLoadError("");
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
    load()
      .catch(() => {
        if (active)
          setLoadError(
            "We couldn’t refresh your picks or pending action. Check your connection and browser storage, then refresh before editing.",
          );
      })
      .finally(() => {
        if (active) {
          refreshInFlight.current = false;
          setRefreshing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, seasonId, user, attempt]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  async function edit(pick?: Pick, choice?: Choice) {
    if (submitting.current || !ready || refreshInFlight.current || loadError)
      return;
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
      setMessage("Vote saved.");
      scheduleRefresh();
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
          setMessage(
            code === "vote_version_conflict"
              ? "This vote changed in another session. We’re reloading your latest choice. Review it before making another edit."
              : rejected[code],
          );
          scheduleRefresh();
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
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(requestedPage, pages);
  const start = (page - 1) * pageSize;
  const pagePicks = visible.slice(start, start + pageSize);
  function changeView(
    nextSearch: string,
    nextFilter: Choice | "ALL",
    nextPage = 1,
    focusResults = false,
  ) {
    const next = new URLSearchParams(searchParams);
    if (nextSearch) next.set("q", nextSearch);
    else next.delete("q");
    if (nextFilter !== "ALL") next.set("choice", nextFilter);
    else next.delete("choice");
    if (nextPage > 1) next.set("page", String(nextPage));
    else next.delete("page");
    scrollToResults.current = focusResults;
    setSearchParams(next, { replace: !focusResults });
  }
  useLayoutEffect(() => {
    if (scrollToResults.current && resultsSummary.current) {
      scrollToResults.current = false;
      resultsSummary.current.focus({ preventScroll: true });
      resultsSummary.current.scrollIntoView?.({ block: "start" });
    }
  }, [page]);
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
      {loadError && (
        <p role="status" className="notice">
          {loadError}
        </p>
      )}
      <button disabled={busy || refreshing} onClick={refresh}>
        {refreshing && ready ? "Refreshing picks…" : "Refresh picks"}
      </button>
      {!ready ? (
        !loadError && <p>Loading your latest choices…</p>
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
              <button
                disabled={busy || refreshing || !!loadError}
                onClick={() => void edit()}
              >
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
              onChange={(e) => changeView(e.target.value, filter)}
            />
            <label htmlFor="picks-filter">Filter choices</label>
            <select
              id="picks-filter"
              value={filter}
              onChange={(e) =>
                changeView(search, e.target.value as Choice | "ALL")
              }
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
            <>
              <p
                ref={resultsSummary}
                tabIndex={-1}
                className="picks-count"
                aria-live="polite"
              >
                Showing {start + 1}–{start + pagePicks.length} of{" "}
                {visible.length} picks
              </p>
              {pages > 1 && (
                <PicksPagination
                  page={page}
                  pages={pages}
                  position="top"
                  onPage={(n) => changeView(search, filter, n, true)}
                />
              )}
              <ul className="picks-list" id="picks-list">
                {pagePicks.map((p) => {
                  return (
                    <li key={p.id}>
                      <article aria-label={p.title} className="pick-card">
                        <Artwork key={p.id} track={p} />
                        <div className="pick-copy">
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
                        </div>
                        <div className="pick-controls">
                          <MusicLinks track={p} />
                          <div
                            className="vote-actions pick-actions"
                            aria-label={`Edit ${p.title}`}
                          >
                            {choices.map((c) => (
                              <button
                                key={c}
                                aria-pressed={p.choice === c}
                                disabled={
                                  busy ||
                                  refreshing ||
                                  !!loadError ||
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
              {pages > 1 && (
                <PicksPagination
                  page={page}
                  pages={pages}
                  position="bottom"
                  onPage={(n) => changeView(search, filter, n, true)}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
