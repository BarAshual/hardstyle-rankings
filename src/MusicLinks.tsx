import type { Track } from "./api";
import appleIcon from "./assets/apple-music-icon-color.svg";
import spotifyIcon from "./assets/spotify-icon-green.svg";

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

export function MusicLinks({ track }: { track: Track | null }) {
  const apple = musicURL(track?.apple_music_url ?? null, "apple");
  const spotify = musicURL(track?.spotify_url ?? null, "spotify");
  return (
    <div className="music-links" aria-label="Listen to this track">
      <p className="music-caption">Listen on</p>
      <div className="music-actions">
        {apple ? (
          <a
            className="music-link apple-link"
            href={apple}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Listen on Apple Music (opens in a new tab)"
          >
            <img src={appleIcon} alt="" />
            <span>Apple Music</span>
          </a>
        ) : (
          <span className="music-unavailable">Apple Music unavailable</span>
        )}
        {spotify ? (
          <a
            className="music-link spotify-link"
            href={spotify}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Listen on Spotify (opens in a new tab)"
          >
            <img src={spotifyIcon} alt="" />
            <span>Spotify</span>
          </a>
        ) : (
          <span className="music-unavailable">Spotify unavailable</span>
        )}
      </div>
    </div>
  );
}
