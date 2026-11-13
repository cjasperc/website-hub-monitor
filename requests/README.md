The hub's Claude tasks add one JSON file here per Check now or Run full review press:
`{ "runId", "kind": "check" or "review", "siteIds", "devices", "requestedAt" }`.
Adding a file starts the speed workflow for those sites. `scripts/ask.mjs` writes it.
