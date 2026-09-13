export { parseJsonField } from "./json-codec";

export function toFtsSearchQuery(value: string) {
	const terms = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms
		.map((term) => term.trim())
		.filter((term) => term.length > 0)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" ");
}
