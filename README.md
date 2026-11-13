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

The hub's **Check now** and **Run full review** buttons start a Claude task, which adds a file
to `requests/` with `scripts/ask.mjs` and pushes it. That push starts the speed workflow for
just the sites in the file. A review also gets screenshots of the live site on desktop and a
phone, a link check and the page's title, description and image facts (`scripts/shots.mjs`,
saved to `data/reviews/<run id>/`). The workflow marks `data/requests/<run id>.json` done or
failed at the end, and the task waits for that with `scripts/wait.mjs`.

## How results reach the hub

`scripts/hub-import.mjs` reads this repo's data and a snapshot of the hub's database, and works
out every write the hub needs: new results, one uptime page per site, and which issues to open,
update or close. The Claude task only copies those writes into the hub, so the numbers and the
issue rules are the same every time. It runs every day at 06:41 UTC and after each request.

| Script | What it does |
| --- | --- |
| `uptime.mjs` | One uptime check of every site, alerts as GitHub issues |
| `speed.mjs`, `summarize.mjs` | Lighthouse runs and the fields the hub keeps |
| `health.mjs` | Certificate, headers, redirect, robots.txt, sitemap.xml |
| `shots.mjs` | Screenshots and page facts, for reviews only |
| `ask.mjs`, `wait.mjs`, `finish.mjs` | Requests from the hub and their status |
| `hub-import.mjs` | The writes that bring all of it into the hub |

## Stopping it

Disable either workflow from the Actions tab, or delete this repo.
