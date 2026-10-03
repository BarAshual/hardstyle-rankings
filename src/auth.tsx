import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import type { API, Identity } from "./api";

type AuthState = {
  identity: Identity | null;
  loading: boolean;
  failed: boolean;
};
const Context = createContext<
  | (AuthState & { api: API; setIdentity: (user: Identity | null) => void })
  | null
>(null);
export function AuthProvider({
  api,
  children,
}: {
  api: API;
  children: ReactNode;
}) {
  const [state, setState] = useState<AuthState>({
    identity: null,
    loading: true,
    failed: false,
  });
  const revision = useRef(0);
  const setIdentity = useCallback((identity: Identity | null) => {
    revision.current += 1;
    setState({ identity, loading: false, failed: false });
  }, []);
  useEffect(() => {
    let active = true;
    const initialRevision = revision.current;
    const unsubscribe = api.subscribe((identity) => {
      if (active) setIdentity(identity);
    });
    api
      .restore()
      .then((identity) => {
        if (active && revision.current === initialRevision)
          setState({ identity, loading: false, failed: false });
      })
      .catch(() => {
        if (active && revision.current === initialRevision)
          setState({ identity: null, loading: false, failed: true });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, setIdentity]);
  return (
    <Context.Provider value={{ ...state, api, setIdentity }}>
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const context = useContext(Context);
  if (!context) throw new Error("AuthProvider missing");
  return context;
}
