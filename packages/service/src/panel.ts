/**
 * The one file the settings panel and the indexer both know about.
 *
 * `panel.json` lives inside an index root and holds choices a human made in the settings page. It is
 * **not** an index artifact: nothing in it describes indexed data, it is rewritten whole on every
 * save, and a missing or unreadable file means "use the configured value" rather than an error — a
 * broken panel must never stop an index run.
 *
 * Two packages read it for different members, which is why the name lives here rather than in either
 * of them: `tool` owns the HTTP surface and writes the document, while `sessions` reads
 * `codexSync` on every run because that choice decides whether Codex history is part of the corpus.
 * A second spelling of the filename would let the panel save a choice the indexer never sees.
 * @module dsh-plugin-sessiongraph-service/panel
 */

/** Name of the settings document inside an index root. */
export const PANEL_FILE_NAME = 'panel.json'

/**
 * The member of `panel.json` that decides whether Codex history is indexed.
 *
 * Absent means "whatever the plugin configuration says": a user who never opened the panel keeps the
 * configured default, and only an explicit save stores a value. Deliberately a bare optional boolean
 * rather than a tri-state — the configuration already owns "default", so the file only ever records
 * a human's deviation from it.
 */
export const PANEL_CODEX_SYNC_KEY = 'codexSync'
