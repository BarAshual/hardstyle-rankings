import { useState } from "react";
import type { Track } from "./api";
export function Artwork({ track }: { track: Track }) {
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
