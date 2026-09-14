import type { Database } from "./sqlite";

export function installNetworkMapRevision(db: Database) {
	db.exec(`
		create table if not exists network_map_revision (
			id integer primary key check (id = 1),
			geometry integer not null,
			details integer not null
		);
		insert or ignore into network_map_revision values (1, 0, 0);
	`);
	const tables = [
		[
			"profiles",
			["id", "handle", "display_name", "followers_count", "location"],
		],
		["follow_edges", ["account_id", "profile_id", "direction", "current"]],
		[
			"geocoded_locations",
			["normalized_key", "lat", "lng", "formatted", "approx_radius_m"],
		],
		["geocoded_locations_unresolved", ["normalized_key", "ttl_until"]],
	] as const;
	for (const [table, columns] of tables) {
		// INSERT also covers REPLACE, whose implicit deletes need not fire delete triggers.
		for (const operation of ["insert", "delete"])
			db.exec(`
				create trigger if not exists network_map_${table}_${operation} after ${operation} on ${table}
				begin update network_map_revision set geometry = geometry + 1 where id = 1; end;
			`);
		installUpdateTrigger(db, table, columns, "geometry");
	}
	installUpdateTrigger(
		db,
		"profiles",
		["avatar_url", "following_count", "verified_type"],
		"details",
	);
}

function installUpdateTrigger(
	db: Database,
	table: string,
	columns: readonly string[],
	revision: "geometry" | "details",
) {
	db.exec(`
		create trigger if not exists network_map_${table}_${revision} after update of ${columns.join(", ")} on ${table}
		when ${columns.map((column) => `old.${column} is not new.${column}`).join(" or ")}
		begin update network_map_revision set ${revision} = ${revision} + 1 where id = 1; end;
	`);
}

export function readNetworkMapRevision(db: Database) {
	// Local writes remain conservative, including values observed in rolled-back transactions.
	const row = db
		.prepare(
			"select geometry, details, total_changes() as localChanges from network_map_revision where id = 1",
		)
		.get() as
		| { geometry: number; details: number; localChanges: number }
		| undefined;
	if (!row) throw new Error("Missing network map revision");
	return row;
}
