import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { createAPI } from "./api";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "./styles.css";

function Root() {
  if (!api)
    return (
      <main className="configuration">
        <h1>Almost ready.</h1>
        <p>
          The app connection hasn’t been configured yet. Check the frontend
          setup guide and restart the dev server.
        </p>
      </main>
    );
  return (
    <BrowserRouter>
      <App api={api} />
    </BrowserRouter>
  );
}
let api: ReturnType<typeof createAPI> | null = null;
try {
  api = createAPI(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );
} catch {
  /* Do not print credentials or raw configuration errors. */
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
