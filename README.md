# Website Hub monitor

Checks the sites in `sites.json` with GitHub Actions and keeps the results in `data/`.
The Website Hub in Claude copies them in each day, and whenever you press **Check now**.

| Check | When | Saved to |
| --- | --- | --- |
| Uptime: does the main page answer, and how fast | Every 5 minutes | `data/uptime/state.json`, `data/uptime/days/` |
| Speed and SEO: Lighthouse 13.6.0, mobile and desktop, median of 3 runs | Daily at 05:05 UTC, and on request | `data/speed/<date>/` |
| Health: certificate expiry, security headers, http to https, robots.txt, sitemap.xml | With the speed check | `data/health/` |

## When a site goes down

After two failed checks in a row (about 10 minutes), the uptime workflow opens an issue
titled "<site> is down". GitHub emails it and sends it to the GitHub app like any issue
that mentions you. The issue closes itself when the site answers again.

## Adding or removing a site

Edit `sites.json`, or change the site in the hub's Setup page and the hub updates this file.
Each site needs an `id`, `name` and `url`. Extra pages go in `pages` as `{ "label", "url" }`.
Set `"active": false` to pause a site without losing its history.

## Requests from the hub

The hub's Check now button adds a file to `requests/`. That push starts the speed workflow
for just the sites in the file, and the workflow writes `data/requests/<run id>.json` when
it's done, which the hub waits for.

## Stopping it

Disable either workflow from the Actions tab, or delete this repo.
