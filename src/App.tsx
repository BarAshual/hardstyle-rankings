import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import {
  friendlyError,
  nicknameError,
  uuidPattern,
  type API,
  type Home,
  type Invitation,
} from "./api";

import { Rating } from "./Rating";

const pendingKey = "hardstyle.pending-invitation";
function pendingInvite() {
  try {
    const token = sessionStorage.getItem(pendingKey);
    return token && uuidPattern.test(token) ? token : null;
  } catch {
    return null;
  }
}
function clearInvite() {
  try {
    sessionStorage.removeItem(pendingKey);
  } catch {
    /* Navigation still succeeds with storage disabled. */
  }
}
function Loading() {
  return (
    <p role="status" className="loading">
      Finding your frequency…
    </p>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="notice">
      {children}
    </p>
  );
}
function SignIn({ token }: { token?: string }) {
  const { api, failed } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      if (token) sessionStorage.setItem(pendingKey, token);
      await api.signIn();
    } catch {
      setError("Google sign-in couldn’t start. Please try again.");
      setBusy(false);
    }
  }
  return (
    <section className="intro">
      <p className="eyebrow">Your crew. Your sound.</p>
      <h1>
        A year of
        <br />
        harder music.
      </h1>
      <p className="lead">
        The tracks that stayed with you.
        <br />
        The ranking only your crew can make.
      </p>
      <div className="entry-card">
        <h2>{token ? "You’re on the list." : "Your season starts here."}</h2>
        <p>Sign in with the Google account that received your invitation.</p>
        {failed && (
          <Notice>
            We couldn’t restore your session. Sign in again to continue.
          </Notice>
        )}
        {error && <Notice>{error}</Notice>}
        <button className="primary" onClick={start} disabled={busy}>
          {busy ? "Opening Google…" : "Continue with Google"}
          <span aria-hidden="true">↗</span>
        </button>
        <p className="fine">Invite only. Your votes stay private.</p>
      </div>
    </section>
  );
}
function RequireAuth({ children }: { children: ReactNode }) {
  const { identity, loading } = useAuth();
  const { token } = useParams();
  if (loading) return <Loading />;
  if (!identity)
    return (
      <SignIn token={token && uuidPattern.test(token) ? token : undefined} />
    );
  return children;
}
function Callback() {
  const { api, setIdentity } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(location.search);
    const code = query.get("code");
    if (query.has("error") || !code) {
      setError(
        "Google sign-in was cancelled or the sign-in link has expired. Please try again.",
      );
      window.history.replaceState(window.history.state, "", "/auth/callback");
      return;
    }
    api
      .complete(code)
      .then((identity) => {
        if (!active) return;
        setIdentity(identity);
        const token = pendingInvite();
        navigate(token ? `/invite/${token}` : "/", { replace: true });
      })
      .catch(() => {
        if (active) {
          setError(
            "We couldn’t finish Google sign-in. Please sign in again in this browser.",
          );
          window.history.replaceState(
            window.history.state,
            "",
            "/auth/callback",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [api, location.search, navigate, setIdentity]);
  return error ? (
    <>
      <Notice>{error}</Notice>
      <Link
        className="button"
        to={pendingInvite() ? `/invite/${pendingInvite()}` : "/"}
      >
        Back to sign in
      </Link>
    </>
  ) : (
    <Loading />
  );
}
function Invite() {
  const { token = "" } = useParams();
  const { api, identity } = useAuth();
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setInvitation(null);
    if (!uuidPattern.test(token)) {
      setError(
        "This invitation link is invalid. Ask your season admin for a new link.",
      );
      setLoading(false);
      return;
    }
    api
      .inspect(token)
      .then((data) => {
        if (!active) return;
        if (data.nickname !== null) {
          clearInvite();
          navigate(`/seasons/${data.season_id}`, { replace: true });
          return;
        }
        setInvitation(data);
      })
      .catch((error) => {
        if (active) setError(friendlyError(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, token, identity?.id, navigate, attempt]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const validation = nicknameError(nickname);
    if (validation) {
      setError(validation);
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const seasonId = await api.accept(token, nickname.trim());
      clearInvite();
      navigate(`/seasons/${seasonId}`, { replace: true });
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (!invitation)
    return (
      <section>
        <h1>Invitation unavailable</h1>
        <Notice>{error}</Notice>
        <p>
          Use the Google account that received your invitation, or ask your
          admin to check the link.
        </p>
        <button onClick={() => setAttempt(attempt + 1)}>Try again</button>
        <Link className="text-link" to="/" onClick={clearInvite}>
          Your seasons
        </Link>
      </section>
    );
  return (
    <section className="onboarding">
      <p className="eyebrow">{invitation.season_name}</p>
      <h1>
        Choose your <br />
        rave name.
      </h1>
      <p className="lead">What should your crew call you?</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="nickname">Rave name</label>
        <input
          id="nickname"
          autoComplete="nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          aria-describedby="nickname-help"
          aria-invalid={!!error}
          disabled={busy}
        />
        <p id="nickname-help" className="fine">
          1–80 characters. Keep it you.
        </p>
        {error && <Notice>{error}</Notice>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Joining your season…" : "Continue"}
          <span aria-hidden="true">→</span>
        </button>
      </form>
    </section>
  );
}
function Landing() {
  const { api, identity } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "empty" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState("loading");
    const token = pendingInvite();
    if (token) {
      navigate(`/invite/${token}`, { replace: true });
      return;
    }
    api
      .memberships(identity!.id)
      .then((rows) => {
        if (!active) return;
        if (rows.length)
          navigate(`/seasons/${rows[0].season_id}`, { replace: true });
        else setState("empty");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [api, identity, navigate, attempt]);
  if (state === "loading") return <Loading />;
  return (
    <section>
      <p className="eyebrow">You’re signed in</p>
      <h1>{state === "empty" ? "Find your crew." : "Let’s try again."}</h1>
      <p>
        {state === "empty"
          ? "Open the invitation link from your season admin to join. Signing in alone doesn’t give access to a season."
          : "We couldn’t load your season. Please try again."}
      </p>
      <button
        onClick={() => {
          clearInvite();
          setAttempt(attempt + 1);
        }}
      >
        Check again
      </button>
    </section>
  );
}
function SeasonHome() {
  const { seasonId = "" } = useParams();
  const { api, identity } = useAuth();
  const [home, setHome] = useState<Home | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "missing">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState("loading");
    if (!uuidPattern.test(seasonId)) {
      setState("missing");
      return;
    }
    api
      .home(seasonId, identity!.id)
      .then((data) => {
        if (active) {
          setHome(data);
          setState(data ? "ready" : "missing");
        }
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [api, identity, seasonId, attempt]);
  if (state === "loading") return <Loading />;
  if (state !== "ready" || !home)
    return (
      <section>
        <h1>Season unavailable</h1>
        <Notice>
          {state === "missing"
            ? "This season isn’t available to your account."
            : "We couldn’t load your progress. Please try again."}
        </Notice>
        <button onClick={() => setAttempt(attempt + 1)}>Try again</button>
        <Link to="/" className="text-link" onClick={clearInvite}>
          Your seasons
        </Link>
      </section>
    );
  const { season, nickname, progress } = home;
  const status = {
    SETUP: "Getting ready",
    VOTING: "Voting is open",
    LOCKED: "Voting is closed",
    REVEAL: "Reveal season",
  }[season.state];
  return (
    <section className="home">
      <p className="eyebrow">{season.name}</p>
      <h1>
        Welcome, <br />
        <span>{nickname}.</span>
      </h1>
      <p className="status">
        <span aria-hidden="true" />
        {status}
      </p>
      <div className="progress-card">
        <p className="eyebrow">Your year in tracks</p>
        <p className="track-total">
          <strong>{progress.rated}</strong>
          <span> / {progress.active_tracks}</span>
        </p>
        <p>tracks rated</p>
        <progress
          aria-label="Tracks rated"
          value={progress.rated}
          max={Math.max(1, progress.active_tracks)}
        />
        <p className="fine">
          {progress.unrated} {progress.unrated === 1 ? "track" : "tracks"}{" "}
          waiting for your take
        </p>
        <div className="super-likes">
          <span aria-hidden="true">✦</span>
          <div>
            <strong>
              {progress.super_likes_available} Super Likes available
            </strong>
            <p>{progress.super_likes_used} used this season</p>
          </div>
        </div>
      </div>
      <p className="footnote">
        Your votes are yours. The group’s preferences stay private until reveal.
      </p>
      {
        <Link className="button primary" to={`/seasons/${seasonId}/rate`}>
          {season.state === "VOTING"
            ? progress.rated
              ? "Continue rating"
              : "Start rating"
            : "View rating status"}{" "}
          →
        </Link>
      }
    </section>
  );
}
function Shell() {
  const { api, identity, setIdentity } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await api.signOut();
      clearInvite();
      setIdentity(null);
    } catch {
      setError("We couldn’t sign you out. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app">
      <header>
        <Link to="/" className="wordmark" aria-label="Hardstyle Rankings home">
          HS<span>/</span>26
        </Link>
        {identity && (
          <button className="sign-out" onClick={signOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out / switch account"}
          </button>
        )}
      </header>
      <main>
        {error && <Notice>{error}</Notice>}
        <Routes>
          <Route path="/auth/callback" element={<Callback />} />
          <Route
            path="/invite/:token"
            element={
              <RequireAuth>
                <Invite key={identity?.id} />
              </RequireAuth>
            }
          />
          <Route
            path="/seasons/:seasonId/rate"
            element={
              <RequireAuth>
                <Rating />
              </RequireAuth>
            }
          />
          <Route
            path="/seasons/:seasonId"
            element={
              <RequireAuth>
                <SeasonHome key={identity?.id} />
              </RequireAuth>
            }
          />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Landing key={identity?.id} />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer>
        HARDSTYLE RANKINGS <span>FOR THE CREW.</span>
      </footer>
    </div>
  );
}
export function App({ api }: { api: API }) {
  return (
    <AuthProvider api={api}>
      <Shell />
    </AuthProvider>
  );
}
