# Media Universe: stage 2 skeleton

Tests need no install (Node 22 built-ins). Production needs `npm install` for `pg` (the host does this at deploy).

```
node --test "tests/*.test.mjs"         # run tests
LINE_CHANNEL_SECRET=... LINE_ALLOWED_USER_IDS=U123,U456 node api/server.mjs
psql "$DATABASE_URL" -f db/schema.sql
```

## Layout
- `db/schema.sql`: PostgreSQL schema (ledger is the only source of spend)
- `gateway/policy.mjs`: kill switch, actor, idempotency, gates A-D, job/daily budget
- `gateway/gateway.mjs`: the only path to providers (decide, task, ledger, audit); `store-memory.mjs` for tests, `store-pg.mjs` for Supabase (untested live)
- `providers/openai-image.mjs`: ChatGPT Image adapter (request shape unverified live)
- `db/seed_rates.sql`: starter provider_rates, re-check prices before use
- `api/line.mjs`, `api/server.mjs`: signature check on raw body, allowlist, Thai commands, postbacks

## Next
1. Wire `decide()` to Postgres (jobs, approvals, ledger, kill_switch) and add the ChatGPT Image adapter.
2. Expose it as the only code path that calls providers.
3. Add Veo/ElevenLabs adapters behind the same gate.
4. n8n last: cron, digest, watchdog.

## Env
`LINE_CHANNEL_SECRET`, `LINE_ALLOWED_USER_IDS` (comma separated), `DATABASE_URL`, provider keys in a secret manager, never in n8n.
