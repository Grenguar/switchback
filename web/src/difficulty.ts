import type { PlannedRoute } from "./planner";

export type RouteDifficulty = Readonly<{ level: "easy" | "moderate" | "difficult" | "unrated"; gainPerKm: number | null; rationale: string; limitations: string }>;

export const assessRouteDifficulty = (route: PlannedRoute): RouteDifficulty => {
  if (route.ascentM === null) return { level: "unrated", gainPerKm: null, rationale: "Elevation sampling is unavailable, so the route cannot be classified responsibly.", limitations: "Surface, obstacles, exposure, and technical-grade coverage are incomplete." };
  const gainPerKm = Math.round(route.ascentM / route.distanceKm);
  const difficultTag = route.segments.some((segment) => /demanding|difficult|alpine/i.test(segment.sac_scale ?? ""));
  if (difficultTag || route.ascentM >= 700 || gainPerKm >= 120) return { level: "difficult", gainPerKm, rationale: `${route.ascentM} m of sampled ascent over ${route.distanceKm} km exceeds the easy/moderate climb threshold.`, limitations: "This is not field verification of exposure, loose rubble, closures, or navigation risk." };
  if (route.ascentM >= 100 || gainPerKm >= 35) return { level: "moderate", gainPerKm, rationale: `${route.ascentM} m of sampled ascent over ${route.distanceKm} km (${gainPerKm} m/km) is not the minimal elevation change required for an easy walk.`, limitations: "Surface, obstacles, exposure, and SAC technical-grade tags are incomplete; confirm conditions locally." };
  return { level: "unrated", gainPerKm, rationale: `${route.ascentM} m of sampled ascent is low, but available terrain tags do not prove an easy route.`, limitations: "Surface, obstacles, exposure, and SAC technical-grade tags are incomplete; confirm conditions locally." };
};
