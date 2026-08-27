import type { PlannedRoute, Waypoint } from "./planner";
import { TrailPlanner } from "./planner";

export type RouteMetrics = Readonly<{
  distanceKm: number;
  officialMatchPercent: number;
}>;

export type WaypointEdit = Readonly<{
  kind: "waypoint";
  revision: number;
  waypoint: Readonly<Waypoint>;
  requestedTargetKm: number;
  before: RouteMetrics;
  after: RouteMetrics;
  delta: Readonly<{
    distanceKm: number;
    officialMatchPercent: number;
  }>;
  targetErrorKm: number;
}>;

const metricsFor = (route: PlannedRoute): RouteMetrics => Object.freeze({
  distanceKm: route.distanceKm,
  officialMatchPercent: route.waymarkedPercent,
});

/**
 * Owns the mutable route chosen in one browser session. A failed waypoint
 * replan never changes this state; a successful replan and its audit record
 * are committed together after the graph calculation completes.
 */
export class RouteSession {
  private activeRoute: PlannedRoute;
  private latestEdit: WaypointEdit | undefined;
  private routeRevision = 0;

  constructor(initialRoute: PlannedRoute, private readonly requestedTargetKm: number) {
    this.activeRoute = initialRoute;
  }

  get route(): PlannedRoute { return this.activeRoute; }
  get lastEdit(): WaypointEdit | undefined { return this.latestEdit; }
  get revision(): number { return this.routeRevision; }

  commitWaypoint(planner: TrailPlanner, waypoint: Waypoint, preferWaymarked = true): WaypointEdit {
    const before = metricsFor(this.activeRoute);
    // Calculate everything before assigning either piece of session state.
    // Therefore a throw preserves the prior active route and prior edit.
    const nextRoute = planner.replanViaWaypoint(this.activeRoute, waypoint, preferWaymarked);
    const after = metricsFor(nextRoute);
    const edit: WaypointEdit = Object.freeze({
      kind: "waypoint",
      revision: this.routeRevision + 1,
      waypoint: Object.freeze({ latitude: waypoint.latitude, longitude: waypoint.longitude }),
      requestedTargetKm: this.requestedTargetKm,
      before,
      after,
      delta: Object.freeze({
        distanceKm: Math.round((after.distanceKm - before.distanceKm) * 10) / 10,
        officialMatchPercent: after.officialMatchPercent - before.officialMatchPercent,
      }),
      targetErrorKm: Math.round((after.distanceKm - this.requestedTargetKm) * 10) / 10,
    });
    this.activeRoute = nextRoute;
    this.latestEdit = edit;
    this.routeRevision += 1;
    return edit;
  }
}
