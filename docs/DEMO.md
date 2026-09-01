# Switchback WebMCP demo

Use the full, timestamped recording script in [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md).

The essential story is: a natural-language request becomes a graph-verified
route on the person’s map; forecast and official-alert context are visible and
source-labelled; and the person retains final control over messages and GPX
download.

## Live smoke test

In the ChatGPT desktop app built-in browser, open the production URL and use:

```text
Use the Switchback site tools on this page. Plan a 7 km loop from
vista_rica_parking with prefer_waymarked true. Summarize the route and the
available forecast and Park-alert context, then prepare a family / friends
briefing.
```

Expected: `plan_route` renders before it returns; the page ledger and invocation
log show the action; the map shows a loop; forecast and notices are visibly
labelled; and the briefing remains a human-controlled copy action. If site tools
are not offered for the account/model, record the normal UI flow separately and
do not claim the WebMCP call was verified.
