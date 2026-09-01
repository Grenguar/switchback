# Switchback operations and data boundaries

## Runtime pieces

| Component | Responsibility | Failure behavior |
| --- | --- | --- |
| TrailPack | Static, local directed graph used for all route selection. | Planning fails closed when a valid circuit cannot be formed. |
| Map | Amazon Location terrain/reference layer. | Routing still relies on local TrailPack evidence. |
| Open-Meteo | Three-day forecast planning context around the active route. | Route remains usable and states that forecast is unavailable. |
| Park-alert adapter | Same-origin Netlify function that fetches the official active-alert page. | Original route recommendation remains TrailPack-only; user gets the official source link. |
| AWS Translate | Optional Catalan-to-English machine translation of Park-alert title and excerpt. | Original Catalan notice remains visible; no translation is invented. |

## Park-alert endpoint

`GET /api/park-alerts` fetches the Park’s explicitly labelled active-alert
section, parses up to eight notices, and returns their titles, publication dates,
excerpts, official links, and optional translations. It does not decide whether
an alert applies to a particular route or whether it is still in force.

The function sends a cacheable response and is rate-limited by Netlify to **20
requests per IP per 60 seconds**. This protects both the official Park source
and optional translation spend.

## Translation configuration

Create a dedicated AWS IAM identity that permits only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "translate:TranslateText",
    "Resource": "*"
  }]
}
```

In Netlify, set these as **server-only Function** environment variables for
production and deploy previews. They must not have a `VITE_` prefix:

```text
SWITCHBACK_TRANSLATE_REGION=eu-west-1
SWITCHBACK_TRANSLATE_ACCESS_KEY_ID=...
SWITCHBACK_TRANSLATE_SECRET_ACCESS_KEY=...
```

Netlify reserves the standard `AWS_REGION` name, so Switchback reads the custom
names and passes them explicitly to the AWS SDK. Environment values are frozen
per deploy: redeploy after editing them.

Never put any translation credential in client-side JavaScript, source control,
or a `VITE_*` variable. The local `.env` file is ignored and should be mode 600.

## Verification

Run the deterministic checks:

```sh
pnpm --dir web run build
pnpm --dir web run test
```

Verify the deployed alert endpoint without printing credentials:

```sh
curl -fsS https://switchback-mvp-igor.netlify.app/api/park-alerts
```

Expected when AWS Translate is configured: each live alert includes a
`translation` object whose `language` is `en`; the original Catalan `title` and
`excerpt` remain present. Expected when it is not configured or fails: alerts
still return with `translation: null`.

## Data limitations to communicate

- TrailPack data proves a graph-verified planned circuit, not current signage,
  closures, surface, exposure, obstacles, technical grade, or navigation risk.
- LiDAR ascent is sampled after rendering; it is not an ascent/grade constraint
  during route selection.
- Forecast is a model grid-cell planning signal, not on-trail observation or
  weather alert.
- Park alerts are published notices, not automatic route-specific closure
  decisions. Read the original and follow its source link before departure.
- Machine translations assist comprehension but never replace the official
  Catalan notice for a safety decision.
