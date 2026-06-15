import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number) {
	const [debouncedValue, setDebouncedValue] = useState(value);

	useEffect(() => {
		const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
		return () => window.clearTimeout(timeout);
	}, [delayMs, value]);

	return debouncedValue;
}
