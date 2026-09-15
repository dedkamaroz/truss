# Plan: Lookup and List columns for databases

Branch: `feature/lookup-list`. Build Lookup first (independent), then List. Each lands as its own commit after `/dualcheck`.

## Agreed behaviour

**Lookup** (VLOOKUP): config `{ sourcePropertyId, targetModuleId, matchPropertyId, returnPropertyId }`.
- Live and read-only. Exact match, case-insensitive, trimmed, on the display text of the source and match columns. First match in the target's row order.
- Empty search value: blank. Value but no match: `#N/A`.
- Recomputes when this row or the target database changes (existing related-database polling, 2 s).
- Target database deleted: config resets (targetModuleId and column ids null), same as relations.

**List from database**: config `{ sourceModuleId, sourceDeleted }`; one per database; cannot point at itself.
- Each row stores `{ id, text }`: the source row id and its last known title. The column shows the live source title when loaded, else the stored text.
- The database has one row per source row. Rows are only added by the list sync (the server refuses row creation otherwise).
- Source row added: a row is added (title filled with the source text). Source row renamed: stored text updated; the row's title follows while it still equals the old text.
- Source row deleted: the row stays, flagged "No longer in <source>", and becomes deletable. Rows still in the source can't be deleted (server 400).
- Adding the column to a database that already has rows: existing rows are matched to source rows by title (case-insensitive); unmatched rows stay, flagged.
- Source database deleted: config `{ sourceModuleId: null, sourceDeleted: true }`; rows kept and flagged; column shows "Source deleted"; row creation unlocked.

## Server (`server/routes/database.js`, `database-io.js`)

1. `VALUE_TYPES.lookup = { readOnly }`, `VALUE_TYPES.list = { readOnly }`; `READ_ONLY` gains both.
2. `normaliseConfig`: lookup (merge; ids via `optId`), list (sourceModuleId via `optId`, sourceDeleted boolean).
3. `createProperty`/`updateProperty`: list checks (source exists and is a database, not self, at most one list property), then `syncList`. Changing a list's source re-links rows.
4. `syncList(moduleId)`: add missing rows, refresh stored text/title, match unlinked rows by title. Called from `snapshot()`, `stamp()` and after list property changes (lazy sync, so a source change reaches the list database the next time anything reads it; open views poll the source and reload).
5. `insertRow` refuses when the database has an active list property (unless called by the sync). `deleteRows` refuses rows whose source row still exists.
6. `unlinkTarget` also resets lookups that target the deleted database and marks list properties `sourceDeleted`.
7. `convertValue`/`valueToText`: list values convert as their text.
8. JSON import: lookup created in the computed pass (ids mapped like rollups); list imported as a text column holding the stored text.

## Client (`web/modules/database/`)

1. `relations.js`: `lookupParts`, `lookupValue` (per-GEN index of the target's match column: lowercased text to first row), `lookupKind`, `lookupSetup` dialog; `listSetup` via `relationSetup` with a list mode (no two-way switch, excludes this database).
2. `types.js`: `lookup` and `list` entries (render, text, compare, filters, formula, setup, menuItems). New hooks `target(prop)` (database a column reads from) and `locksRows`.
3. `store.js`: `ensureRelated` loads every `target(prop)`; when a related database changes and a list property reads from it, reload this database; `rowsLocked()`.
4. `index.js`: `ctx.addRow` refuses with a toast when rows are locked; root class `is-rows-locked` hides add-row controls; CSV import into the database is disabled.
5. `database.css`: flagged-row badge and hidden add controls.
6. `static.test.js` constraints hold: no type-name branching outside `types.js`.

## Verification

- Server tests (`tests/database-relations-io/api.test.js`): lookup config and reset on target delete; list sync on create, add, rename, delete; row creation refused; delete of in-source rows refused; matching existing rows by title; source delete; JSON import of both types.
- Browser tests (`tests/database-relations-io/lookup-list.e2e.js`): lookup shows value, `#N/A`, blank, and updates when the target changes; list column fills rows, a new source row appears in the open view with its lookup filled, renamed rows follow, deleted source rows are flagged, add-row controls hidden.
- Mutation check on the key guards; full `npm test` and Playwright suites.
