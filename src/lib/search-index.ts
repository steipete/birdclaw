import type { Database } from "./sqlite";

type SearchKind = "tweet" | "dm";

function searchTables(kind: SearchKind) {
	return kind === "tweet"
		? {
				source: "tweets",
				fts: "tweets_fts",
				id: "tweet_id",
				active: "s.deleted_at is null and s.superseded_at is null",
			}
		: { source: "dm_messages", fts: "dm_fts", id: "message_id", active: "1" };
}

/** Search row IDs have an INTEGER PRIMARY KEY so VACUUM cannot renumber them. */
export function installSearchRowIds(db: Database) {
	db.exec(`
		create table if not exists search_rows (
			id integer primary key,
			kind text not null,
			source_id text not null,
			unique(kind, source_id)
		);
		delete from search_rows;
	`);
	for (const kind of ["tweet", "dm"] as const) {
		const { source, fts, id, active } = searchTables(kind);
		db.exec(`
			delete from ${fts};
			insert into search_rows(kind, source_id)
			select '${kind}', s.id from ${source} s where ${active} order by s.rowid;
			insert into ${fts}(rowid, ${id}, text)
			select r.id, s.id, s.text from ${source} s
			join search_rows r on r.kind='${kind}' and r.source_id=s.id
			where ${active} order by r.id;
		`);
	}
}

/** Call within the canonical write transaction, after merging all source rows. */
export function refreshSearchRows(
	db: Database,
	kind: SearchKind,
	ids: readonly string[],
) {
	if (ids.length === 0) return;
	const { source, fts, id, active } = searchTables(kind);
	const uniqueIds = [...new Set(ids)];
	const replaceBatch = uniqueIds.length >= 4096;
	const read = db.prepare(`
		select input.value source_id, r.id search_id, s.id canonical_id, s.text,
		  (${active}) active,
		  ${replaceBatch ? "r.id indexed_id, null indexed_source_id, null indexed_text" : `f.rowid indexed_id, f.${id} indexed_source_id, f.text indexed_text`}
		from json_each(?) input
		left join ${source} s on s.id=input.value
		left join search_rows r on r.kind='${kind}' and r.source_id=input.value
		${replaceBatch ? "" : `left join ${fts} f on f.rowid=r.id`}
	`);
	const insert = db.prepare(`
		insert into ${fts}(rowid, ${id}, text)
		select json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]')
		from json_each(?) order by cast(json_extract(value,'$[0]') as integer)
	`);
	// Bound memory and finish each batch's FTS reads before writing pending tokens.
	for (let offset = 0; offset < uniqueIds.length; offset += 4096) {
		const rows = read.all(
			JSON.stringify(uniqueIds.slice(offset, offset + 4096)),
		) as Array<{
			source_id: string;
			search_id: number | null;
			canonical_id: string | null;
			text: string | null;
			active: number | null;
			indexed_id: number | null;
			indexed_source_id: string | null;
			indexed_text: string | null;
		}>;
		const changed = rows.filter(
			(row) =>
				row.canonical_id !== null &&
				row.active &&
				(replaceBatch ||
					row.indexed_id === null ||
					row.indexed_text !== row.text ||
					row.indexed_source_id !== row.source_id),
		);
		const newIds = changed
			.filter((row) => row.search_id === null)
			.map((row) => row.source_id);
		const allocated = newIds.length
			? (db
					.prepare(`
			insert into search_rows(kind,source_id) select ?,value from json_each(?) returning id,source_id
		`)
					.all(kind, JSON.stringify(newIds)) as {
					id: number;
					source_id: string;
				}[])
			: [];
		const byId = new Map(allocated.map((row) => [row.source_id, row.id]));
		const removed = rows.filter(
			(row) =>
				row.indexed_id !== null &&
				(replaceBatch ||
					row.canonical_id === null ||
					!row.active ||
					row.indexed_text !== row.text ||
					row.indexed_source_id !== row.source_id),
		);
		if (removed.length)
			db.prepare(
				`delete from ${fts} where rowid in (select value from json_each(?))`,
			).run(JSON.stringify(removed.map((row) => row.indexed_id)));
		if (changed.length)
			insert.run(
				JSON.stringify(
					changed.map((row) => [
						row.search_id ?? byId.get(row.source_id)!,
						row.source_id,
						row.text,
					]),
				),
			);
		const missing = rows
			.filter((row) => row.canonical_id === null && row.search_id !== null)
			.map((row) => row.search_id);
		if (missing.length)
			db.prepare(
				"delete from search_rows where id in (select value from json_each(?))",
			).run(JSON.stringify(missing));
	}
}

/** Remove search entries for deleted canonical rows within the same transaction. */
export function deleteSearchRows(
	db: Database,
	kind: SearchKind,
	ids: readonly string[],
) {
	if (ids.length === 0) return;
	const { fts } = searchTables(kind);
	db.prepare(`
		delete from ${fts} where rowid in (
			select id from search_rows where kind=? and source_id in (select value from json_each(?))
		)
	`).run(kind, JSON.stringify(ids));
	db.prepare(
		"delete from search_rows where kind=? and source_id in (select value from json_each(?))",
	).run(kind, JSON.stringify(ids));
}
