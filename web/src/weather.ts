import type { PlannedRoute } from "./planner";

export type WeatherWindow = Readonly<{ date: string; start: string; end: string; summary: string; temperatureC: number; precipitationProbability: number; precipitationMm: number; windKph: number; gustKph: number; score: number }>;
export type TrailWeather = Readonly<{ checkedAt: string; timezone: string; source: string; windows: readonly WeatherWindow[]; bestWindow: WeatherWindow; caution: string }>;

type HourlyForecast = { time: unknown; temperature_2m: unknown; precipitation_probability: unknown; precipitation: unknown; weather_code: unknown; wind_speed_10m: unknown; wind_gusts_10m: unknown };
type ForecastResponse = { timezone?: unknown; hourly?: HourlyForecast };

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
  });
  return `https://api.open-meteo.com/v1/forecast?${parameters}`;
};

/** Compares three daytime windows per local forecast day; it does not certify trail safety. */
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
  const windows: WeatherWindow[] = [];
  for (const startHour of [8, 11, 14]) {
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
      windows.push(Object.freeze({ date: time.slice(0, 10), start: `${String(startHour).padStart(2, "0")}:00`, end: `${String(startHour + 3).padStart(2, "0")}:00`, summary: descriptionFor(weatherCode), temperatureC, precipitationProbability, precipitationMm, windKph, gustKph, score: scoreWindow(temperatureC, precipitationProbability, precipitationMm, windKph, gustKph, weatherCode) }));
    }
  }
  if (windows.length < 3) throw new Error("Weather forecast did not include three local daytime windows.");
  const bestWindow = [...windows].sort((left, right) => left.score - right.score)[0]!;
  return Object.freeze({ checkedAt: new Date().toISOString(), timezone, source: "Open-Meteo forecast", windows: Object.freeze(windows), bestWindow, caution: "Forecast conditions can change and represent a model grid cell, not on-trail conditions. Check official weather alerts, closures, and local conditions before departure." });
}
