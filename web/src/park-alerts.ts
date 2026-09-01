export type ParkAlert = Readonly<{ title: string; published: string; excerpt: string; url: string }>;
export type ParkAlerts = Readonly<{ sourceUrl: string; fetchedAt: string; alerts: readonly ParkAlert[]; caution: string }>;

type ParkAlertsResponse = { source_url?: unknown; fetched_at?: unknown; alerts?: unknown; caution?: unknown; error?: unknown };

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Park alerts ${label} is unavailable.`);
  return value.trim();
};
const parkUrl = (value: unknown): string => {
  const url = new URL(text(value, "URL"));
  if (url.protocol !== "https:" || url.hostname !== "parcnaturalcollserola.cat") throw new Error("A Park alert URL is invalid.");
  return url.toString();
};

/** Reads the same-origin server adapter; the browser never scrapes the Park directly. */
export async function fetchParkAlerts(fetcher: typeof fetch = fetch): Promise<ParkAlerts> {
  const response = await fetcher("/api/park-alerts", { signal: AbortSignal.timeout(10_000) });
  let data: ParkAlertsResponse;
  try { data = await response.json() as ParkAlertsResponse; }
  catch { throw new Error("Park alerts adapter is unavailable. Open the official alert page before departure."); }
  if (!response.ok || !Array.isArray(data.alerts)) throw new Error(typeof data.error === "string" ? data.error : "Park alerts are temporarily unavailable. Open the official source before departure.");
  const alerts = data.alerts.map((value): ParkAlert => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("A Park alert is invalid.");
    const alert = value as Record<string, unknown>;
    return Object.freeze({ title: text(alert.title, "title"), published: text(alert.published, "date"), excerpt: text(alert.excerpt, "excerpt"), url: parkUrl(alert.url) });
  });
  return Object.freeze({ sourceUrl: text(data.source_url, "source URL"), fetchedAt: text(data.fetched_at, "fetch time"), alerts: Object.freeze(alerts), caution: text(data.caution, "caution") });
}
