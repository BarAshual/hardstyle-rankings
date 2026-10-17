import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MusicLinks, musicURL } from "../../src/MusicLinks";
import { Artwork } from "../../src/Artwork";
import type { Track } from "../../src/api";
const track: Track = {
  id: "track",
  title: "Track",
  artists: [],
  artwork_url: "https://example.com/missing.jpg",
  spotify_url: "https://open.spotify.com/track/1",
  apple_music_url: "https://music.apple.com/us/album/1",
};
it("uses local brand assets, accessible names, and existing external-link attributes", () => {
  render(<MusicLinks track={track} />);
  const links = screen.getAllByRole("link");
  expect(links[0]).toHaveAccessibleName(
    "Listen on Apple Music (opens in a new tab)",
  );
  expect(links[1]).toHaveAccessibleName(
    "Listen on Spotify (opens in a new tab)",
  );
  for (const link of links) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.querySelector("img")?.getAttribute("src")).toMatch(
      /^(?:\/src\/assets\/|data:image\/svg\+xml[,;])/,
    );
  }
});
it("renders unavailable providers without active links", () => {
  render(
    <MusicLinks
      track={{
        ...track,
        spotify_url: "https://open.spotify.com.evil.test/track/1",
        apple_music_url: null,
      }}
    />,
  );
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText("Apple Music unavailable")).toBeInTheDocument();
  expect(
    musicURL("https://user:pass@open.spotify.com/track/1", "spotify"),
  ).toBeNull();
});
it("replaces a failed artwork load with a placeholder", () => {
  const { container } = render(<Artwork track={track} />);
  fireEvent.error(container.querySelector("img")!);
  expect(
    screen.getByRole("img", { name: "Track artwork placeholder" }),
  ).toBeInTheDocument();
});
