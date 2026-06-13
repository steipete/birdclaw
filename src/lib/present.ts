export function formatCompactNumber(value: number) {
	return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const timeFormatter = new Intl.DateTimeFormat("en", {
	hour: "numeric",
	minute: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat("en", {
	weekday: "long",
});

const sameYearDateFormatter = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
});

const otherYearDateFormatter = new Intl.DateTimeFormat("en", {
	year: "numeric",
	month: "short",
	day: "numeric",
});

const exactTimestampFormatter = new Intl.DateTimeFormat("en", {
	year: "numeric",
	month: "long",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	second: "2-digit",
	timeZoneName: "short",
});

function parseTimestamp(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function localCalendarDay(date: Date) {
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function formatCalendarTimestamp(date: Date, now: Date) {
	const time = timeFormatter.format(date);
	const dayDifference = localCalendarDay(now) - localCalendarDay(date);

	if (dayDifference === 1) {
		return `Yesterday at ${time}`;
	}

	if (dayDifference >= 2 && dayDifference <= 6) {
		return `${weekdayFormatter.format(date)} at ${time}`;
	}

	const dateFormatter =
		date.getFullYear() === now.getFullYear()
			? sameYearDateFormatter
			: otherYearDateFormatter;
	return `${dateFormatter.format(date)} at ${time}`;
}

export function formatShortTimestamp(value: string) {
	const date = parseTimestamp(value);
	if (!date) return value;

	return new Intl.DateTimeFormat("en", {
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		day: "numeric",
	}).format(date);
}

export function formatExactTimestamp(value: string) {
	const date = parseTimestamp(value);
	return date ? exactTimestampFormatter.format(date) : value;
}

export function formatSmartTimestamp(value: string, nowValue = Date.now()) {
	const date = parseTimestamp(value);
	const now = new Date(nowValue);
	if (!date || Number.isNaN(now.getTime())) return value;

	const elapsed = now.getTime() - date.getTime();
	if (elapsed >= -45 * SECOND_MS && elapsed < 45 * SECOND_MS) {
		return "just now";
	}

	if (elapsed < 0) {
		return formatCalendarTimestamp(date, now);
	}

	if (elapsed < HOUR_MS) {
		const minutes = Math.max(1, Math.floor(elapsed / MINUTE_MS));
		return `${minutes} min ago`;
	}

	if (elapsed < DAY_MS) {
		const hours = Math.max(1, Math.floor(elapsed / HOUR_MS));
		return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	}

	return formatCalendarTimestamp(date, now);
}

export function getInitials(value: string) {
	return value
		.split(" ")
		.map((part) => part[0] ?? "")
		.join("")
		.slice(0, 2);
}
