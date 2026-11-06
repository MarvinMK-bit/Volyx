# Volyx test suites

Six suites, 205 checks. They run against a **throwaway copy** of the app on port 3100 with an
empty `data/`, so they never touch real accounts or gradings.

```bash
cd tests
npm install     # jsdom, the only dependency
npm test        # or: bash run-all.sh
```

| Suite | Checks | What it proves |
|---|---|---|
| `api.test.mjs` | 35 | signup → email code → login, students, uploads, report cards, isolation |
| `platform.api.test.mjs` | 37 | admin-only key, cross-teacher visibility by email, page store auth, clear-results |
| `platform.ui.test.mjs` | 25 | role picker, admin platform page, teacher/student views (jsdom) |
| `viewer.ui.test.mjs` | 51 | the marked-work viewer: glyph paths, grade maths, question ⇄ mark spotlight |
| `upload.ui.test.mjs` | 13 | upload resilience: inline reasons, retry, photo conversion, confirmation |
| `design.ui.test.mjs` | 44 | the light-grey/slate/cyan 60/30/10 palette (hues asserted), type floor and scale, `COPY`, contrast, one action per screen |

Point them at another server with `BASE=http://host:port node api.test.mjs`.
