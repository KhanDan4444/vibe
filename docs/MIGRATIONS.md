# Database migrations

## Production

1. Set `NODE_ENV=production` (schema.sql is **not** applied on boot).
2. Run migrations after deploy / before traffic:

```bash
npm run db:migrate
```

3. To force one-time bootstrap from `schema.sql` (new empty DB only):

```bash
RUN_SCHEMA_BOOTSTRAP=1 node server.js
# then npm run db:migrate  # records ledger for future files
```

## Development

By default boot still runs `schema.sql` (unless `RUN_SCHEMA_BOOTSTRAP=0`). Prefer:

```bash
npm run db:migrate
```

`schema_migrations` tracks applied filenames so a second migrate is a no-op.

## Files

| Path | Role |
|------|------|
| `schema.sql` | Full snapshot for docs / empty bootstrap |
| `migrations/*.sql` | Incremental changes |
| `scripts/migrate.js` | Ledger-aware migrator |
