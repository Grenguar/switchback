import type { PlannedRoute } from "./planner";

export type TimeOfDay = "any" | "morning" | "afternoon" | "evening";
export type Daylight = Readonly<{ date: string; weekday: string; sunrise: string | null; sunset: string | null }>;
export type WeatherWindow = Readonly<{ date: string; start: string; end: string; summary: string; temperatureC: number; precipitationProbability: number; precipitationMm: number; windKph: number; gustKph: number; score: number; daylight: Daylight | undefined; crossesSunset: boolean }>;
export type TrailWeather = Readonly<{ checkedAt: string; timezone: string; source: string; windows: readonly WeatherWindow[]; daylight: readonly Daylight[]; bestWindow: WeatherWindow; caution: string }>;

type HourlyForecast = { time: unknown; temperature_2m: unknown; precipitation_probability: unknown; precipitation: unknown; weather_code: unknown; wind_speed_10m: unknown; wind_gusts_10m: unknown };
type DailyForecast = { time: unknown; sunrise: unknown; sunset: unknown };
type ForecastResponse = { timezone?: unknown; hourly?: HourlyForecast; daily?: DailyForecast };

const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Weather forecast ${label} is invalid.`);
  return value;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Weather forecast ${label} is unavailable.`);
  return value;
};
const descriptionFor = (code: number): string => {
  if (code <= 1) return "clear";
  if (code <= 3) return "cloudy";
  if (code <= 49) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  return "thunderstorms";
};
const scoreWindow = (temperatureC: number, probability: number, precipitationMm: number, windKph: number, gustKph: number, weatherCode: number): number => {
  const temperaturePenalty = Math.max(0, 10 - temperatureC) * 2 + Math.max(0, temperatureC - 25);
  const weatherPenalty = weatherCode >= 95 ? 80 : weatherCode >= 61 ? 28 : weatherCode >= 51 ? 14 : weatherCode >= 45 ? 10 : 0;
  return Math.round(probability * 0.55 + precipitationMm * 18 + windKph * 0.4 + gustKph * 0.55 + temperaturePenalty + weatherPenalty);
};
const routeCentre = (route: PlannedRoute): [number, number] => {
  const points = route.coordinates;
  if (points.length === 0) return [route.start.latitude, route.start.longitude];
  const [latitude, longitude] = points.reduce(([latSum, lonSum], [lat, lon]) => [latSum + lat, lonSum + lon], [0, 0]);
  return [latitude / points.length, longitude / points.length];
};
const forecastUrl = ([latitude, longitude]: [number, number]): string => {
  const parameters = new URLSearchParams({
    latitude: latitude.toFixed(5), longitude: longitude.toFixed(5), timezone: "auto", forecast_days: "3",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
    daily: "sunrise,sunset",
  });
  return `https://api.open-meteo.com/v1/forecast?${parameters}`;
};

const localTime = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(11, 16) : null;
const weekdayFor = (date: string): string => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const daylightFor = (data: ForecastResponse): readonly Daylight[] => {
  const daily = data.daily;
  if (!daily) return [];
  const dates = array(daily.time, "daily dates"); const sunrises = array(daily.sunrise, "sunrises"); const sunsets = array(daily.sunset, "sunsets");
  if (dates.length !== sunrises.length || dates.length !== sunsets.length) throw new Error("Weather forecast daylight arrays do not align.");
  return Object.freeze(dates.flatMap((date, index) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? [Object.freeze({ date, weekday: weekdayFor(date), sunrise: localTime(sunrises[index]), sunset: localTime(sunsets[index]) })] : []));
};

export const recommendedWindow = (forecast: TrailWeather, preference: TimeOfDay = "any"): WeatherWindow => {
  const candidates = preference === "morning" ? forecast.windows.filter((window) => window.start === "08:00")
    : preference === "afternoon" ? forecast.windows.filter((window) => window.start === "11:00" || window.start === "14:00")
      : preference === "evening" ? forecast.windows.filter((window) => window.start === "17:00")
        : forecast.windows;
  return [...(candidates.length > 0 ? candidates : forecast.windows)].sort((left, right) => left.score - right.score)[0]!;
};

/** Compares morning, afternoon, and evening forecast windows; it does not certify trail safety. */
export async function fetchTrailWeather(route: PlannedRoute, fetcher: typeof fetch = fetch): Promise<TrailWeather> {
  const response = await fetcher(forecastUrl(routeCentre(route)), { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Weather forecast request failed with HTTP ${response.status}.`);
  const data = await response.json() as ForecastResponse;
  const timezone = typeof data.timezone === "string" && data.timezone.length > 0 ? data.timezone : "local trail time";
  const hourly = data.hourly;
  if (!hourly) throw new Error("Weather forecast hourly data is unavailable.");
  const times = array(hourly.time, "times"); const temperatures = array(hourly.temperature_2m, "temperatures");
  const probabilities = array(hourly.precipitation_probability, "precipitation probabilities"); const precipitation = array(hourly.precipitation, "precipitation");
  const codes = array(hourly.weather_code, "weather codes"); const wind = array(hourly.wind_speed_10m, "wind speeds"); const gusts = array(hourly.wind_gusts_10m, "wind gusts");
  if (![temperatures, probabilities, precipitation, codes, wind, gusts].every((values) => values.length === times.length)) throw new Error("Weather forecast arrays do not align.");
  const daylight = daylightFor(data); const daylightByDate = new Map(daylight.map((day) => [day.date, day]));
  const windows: WeatherWindow[] = [];
  for (const startHour of [8, 11, 14, 17]) {
    const indexes = times.map((time, index) => ({ time, index })).filter(({ time }) => typeof time === "string" && new RegExp(`T${String(startHour).padStart(2, "0")}:00$`).test(time));
    for (const { time, index } of indexes) {
      if (typeof time !== "string") continue;
      const members = [index, index + 1, index + 2].filter((candidate) => candidate < times.length && typeof times[candidate] === "string" && String(times[candidate]).slice(0, 10) === time.slice(0, 10));
      if (members.length !== 3) continue;
      const average = (values: unknown[], label: string): number => members.reduce((sum, candidate) => sum + finite(values[candidate], label), 0) / members.length;
      const temperatureC = Math.round(average(temperatures, "temperature"));
      const precipitationProbability = Math.round(average(probabilities, "precipitation probability"));
      const precipitationMm = Math.round(members.reduce((sum, candidate) => sum + finite(precipitation[candidate], "precipitation"), 0) * 10) / 10;
      const windKph = Math.round(average(wind, "wind speed")); const gustKph = Math.round(Math.max(...members.map((candidate) => finite(gusts[candidate], "wind gust"))));
      const weatherCode = Math.max(...members.map((candidate) => finite(codes[candidate], "weather code")));
      const date = time.slice(0, 10); const day = daylightByDate.get(date); const end = `${String(startHour + 3).padStart(2, "0")}:00`;
      windows.push(Object.freeze({ date, start: `${String(startHour).padStart(2, "0")}:00`, end, summary: descriptionFor(weatherCode), temperatureC, precipitationProbability, precipitationMm, windKph, gustKph, score: scoreWindow(temperatureC, precipitationProbability, precipitationMm, windKph, gustKph, weatherCode), daylight: day, crossesSunset: day?.sunset !== null && day?.sunset !== undefined ? end > day.sunset : false }));
    }
  }
  if (windows.length < 3) throw new Error("Weather forecast did not include three local planning windows.");
  const bestWindow = [...windows].sort((left, right) => left.score - right.score)[0]!;
  return Object.freeze({ checkedAt: new Date().toISOString(), timezone, source: "Open-Meteo forecast", windows: Object.freeze(windows), daylight, bestWindow, caution: "Forecast conditions can change and represent a model grid cell, not on-trail conditions. Sunrise and sunset are planning context, not proof of usable trail light. Check official weather alerts, closures, and local conditions before departure." });
}
