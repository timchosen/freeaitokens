# Stop test results (Task 0), 2026-11-22

Task: Claude Code 2.1.322 fixes `sum.js` (a - b → a + b) and reruns `node --test`. Shim: spike/shim.ts, upstream Kilo Gateway (no key).
Bar: 4 of 5 passes on at least one free model.

| Model | Passes | Median time |
|---|---|---|
| nvidia/nemotron-3-ultra-550b-a55b:free (Kilo) | 5/5 | 50 s |
| kilo-auto/free (Kilo) | 5/5 | 22 s |

About 9 upstream requests per run, no 429s seen. Gate: PASSED. Keyed providers not tested (no keys supplied yet).
