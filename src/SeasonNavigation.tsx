import { Link } from "react-router-dom";

export function SeasonNavigation({
  seasonId,
  current,
  seasonName,
}: {
  seasonId: string;
  current: "rating" | "picks";
  seasonName?: string;
}) {
  const rating = current === "picks";
  return (
    <nav className="season-navigation" aria-label="Season navigation">
      <Link to={`/seasons/${seasonId}`}>← Home</Link>
      {seasonName && (
        <p className="eyebrow season-navigation-season">{seasonName}</p>
      )}
      <Link
        className="season-navigation-next"
        to={`/seasons/${seasonId}/${rating ? "rate" : "my-picks"}`}
      >
        {rating ? "Rate tracks →" : "My Picks →"}
      </Link>
    </nav>
  );
}
