import { useSyncExternalStore } from "react";
import {
	formatExactTimestamp,
	formatShortTimestamp,
	formatSmartTimestamp,
} from "#/lib/present";

const CLOCK_INTERVAL_MS = 30_000;

type ClockSnapshot = number | null;

const listeners = new Set<() => void>();
let currentNow = Date.now();
let clockInterval: ReturnType<typeof setInterval> | null = null;

function updateClock() {
	currentNow = Date.now();
	for (const listener of listeners) listener();
}

function subscribeToClock(listener: () => void) {
	listeners.add(listener);

	if (clockInterval === null) {
		currentNow = Date.now();
		clockInterval = setInterval(updateClock, CLOCK_INTERVAL_MS);
	}

	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && clockInterval !== null) {
			clearInterval(clockInterval);
			clockInterval = null;
		}
	};
}

function getClockSnapshot(): ClockSnapshot {
	return currentNow;
}

function getServerClockSnapshot(): ClockSnapshot {
	return null;
}

export function SmartTimestamp({
	className,
	value,
}: {
	className?: string;
	value: string;
}) {
	const now = useSyncExternalStore(
		subscribeToClock,
		getClockSnapshot,
		getServerClockSnapshot,
	);
	const exactTimestamp = formatExactTimestamp(value);

	return (
		<time
			aria-label={exactTimestamp}
			className={className}
			dateTime={value}
			title={exactTimestamp}
		>
			{now === null
				? formatShortTimestamp(value)
				: formatSmartTimestamp(value, now)}
		</time>
	);
}
