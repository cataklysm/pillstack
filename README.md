# PillStack

A local-first medication and supplement manager for a single person.
One SQLite file, no server to install, no account, no cloud, works offline.

It answers, at any moment: what am I taking, when do I take it next, what did I
take before, and when did the dose change.

## Requirements

Node.js 22 or newer. Nothing else — no database server, no Docker, no services.

## Getting started

```bash
npm install
npm run build --workspace=contracts   # shared types and schemas

npm run dev:app                       # API on http://127.0.0.1:5174
npm run dev:web                       # UI  on http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173>. The dev server proxies `/api` to the backend.

For a single-process setup, build the UI and let the backend serve it:

```bash
npm run build
npm run start --workspace=app         # everything on http://127.0.0.1:5174
```

### Tests

```bash
npm test            # 272 tests: domain logic, schema invariants, services, HTTP
```

### Where the data lives

`./data/pillstack.sqlite`, or wherever `PILLSTACK_DATA_DIR` points. That single
file is the whole application state. The Backup page writes it to a ZIP you can
put anywhere, validates an archive before restoring it, and always takes a
safety copy of the current database first.

| Variable | Default | Purpose |
|---|---|---|
| `PILLSTACK_DATA_DIR` | `./data` | Where the SQLite file is kept |
| `PILLSTACK_PORT` | `5174` | API port |
| `PILLSTACK_HOST` | `127.0.0.1` | Bind address — changing this exposes health data to your network |

## Layout

```
app/         Node backend: domain, persistence, application, api
web/         Vue 3 single-page app
contracts/   zod schemas and types shared by both
docs/        architecture.md and schema.sql
```

`app/src/domain/` imports nothing but itself — recurrence, timeline building
and plan versioning are pure functions over plain objects. That is what makes
them testable without a database and what will make desktop packaging a change
of shell rather than a rewrite.

See [docs/architecture.md](docs/architecture.md) for the design, and
[docs/schema.sql](docs/schema.sql) for the annotated schema. The initial
migration is generated from that file, and a test fails the build if the two
ever drift.

## Tidying a day

"Tidy this day" on the timeline proposes arranging the day into fewer separate
intake events. It only ever suggests moving a dose *into an intake that already
exists* — it never invents a new time, never touches a dose you pinned or one
tied to a meal, never breaks a rule you wrote, and never makes an existing clash
worse. Nothing is written until you accept, and accepting records single-day
overrides, not a change to your plan.

## Two things worth knowing

**Schedules are versioned, never edited.** Raising a dose closes the current
plan version the day before and opens a new one. Both stay, so "what was I
taking in October?" is a real query and the previous dose is never lost. A
database trigger makes superseded versions physically immutable.

**Moving an intake on the timeline is a one-day exception**, recorded separately
from the plan. Making a change permanent is a plan change, which creates a new
version. Keeping those apart is what stops the daily view from quietly
rewriting your history.

## Status

| Milestone | |
|---|---|
| 1 — setup, SQLite, migrations, products, ingredients, schedules, daily timeline | done |
| 2 — inventory ledger, depletion, reorder dates, intake log, history views | done |
| 3 — constraints, warnings when moving intakes, reminders | done |
| 4 — physician PDF, JSON export, backup and restore | done |
| 5 — UX polish, schedule optimizer, desktop packaging | optimizer and UX done; packaging documented, not built |

The schema already contains the tables for milestones 2 to 4 (inventory,
constraints, reminders, backups) so that later work adds behaviour rather than
migrating data that is already there.

## Privacy

No registration, no telemetry, no analytics, no cloud sync, no external API. The
server binds to the loopback interface. The UI bundles its own fonts and assets
and sets a CSP with no external origins, so nothing about your medication ever
leaves this machine.
