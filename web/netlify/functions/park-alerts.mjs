const SOURCE_URL = "https://parcnaturalcollserola.cat/actualitat/avisos/";
const CACHE_CONTROL = "public, max-age=300, s-maxage=900, stale-while-revalidate=3600";

const decode = (value) => value
  .replace(/<[^>]*>/g, " ")
  .replace(/&#8217;/g, "'").replace(/&#8216;/g, "'").replace(/&#8220;/g, "\"").replace(/&#8221;/g, "\"")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, " ").trim();

/** Extracts only the Park page's explicitly labelled active-alert section. */
export const parseActiveAlerts = (html) => {
  const start = html.indexOf('id="avisos actius"');
  const end = html.indexOf("Avisos anteriors", start);
  if (start < 0 || end < 0) throw new Error("The Park alert page no longer exposes its active-alert section.");
  const cards = html.slice(start, end).split('<div class="tmb ').slice(1);
  const alerts = cards.flatMap((card) => {
    const title = card.match(/<h3 class="t-entry-title[^>]*><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/i);
    const date = card.match(/<span class="t-entry-date">([\s\S]*?)<\/span>/i);
    const excerpt = card.match(/<div class="t-entry-excerpt[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!title || !date || !excerpt) return [];
    return [{ title: decode(title[2]), published: decode(date[1]), excerpt: decode(excerpt[1]), url: title[1] }];
  });
  return alerts.filter((alert, index, all) => all.findIndex((candidate) => candidate.url === alert.url) === index).slice(0, 8);
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": CACHE_CONTROL },
});

export default async (request) => {
  if (request.method !== "GET") return json({ error: "Only GET is supported." }, 405);
  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Switchback trail planner (+https://switchback-mvp-igor.netlify.app)",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`The Park returned HTTP ${response.status}.`);
    const alerts = parseActiveAlerts(await response.text());
    return json({ source_url: SOURCE_URL, fetched_at: new Date().toISOString(), alerts, caution: "These are Park-published notices. Publication in the active list does not by itself prove that a notice applies to this exact route or remains in force; open the source before departure." });
  } catch (error) {
    return json({ source_url: SOURCE_URL, alerts: null, caution: "Park alerts could not be checked. Open the official alert page before departure.", error: error instanceof Error ? error.message : "Unknown alert fetch error." }, 502);
  }
};

export const config = { path: "/api/park-alerts", method: ["GET"] };
