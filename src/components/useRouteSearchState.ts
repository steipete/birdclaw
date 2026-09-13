import { useCallback, useState, type ChangeEvent } from "react";
import type { RouteSearchChange } from "#/lib/route-search";

type TextKey<T> = {
	[K in keyof T]-?: string extends T[K] ? K : never;
}[keyof T];

export function useRouteSearchState<T extends object>(
	controlled: T | undefined,
	onChange: RouteSearchChange<T> | undefined,
	validate: (input: Record<string, unknown>) => T,
) {
	const [local, setLocal] = useState(() => validate({}));
	const searchState = controlled ?? local;
	const updateSearch = useCallback<RouteSearchChange<T>>(
		(next, options) => (onChange ? onChange(next, options) : setLocal(next)),
		[onChange],
	);
	const textInput = (key: TextKey<T>) => ({
		value: String(searchState[key] ?? ""),
		onChange: (event: ChangeEvent<HTMLInputElement>) =>
			updateSearch(
				{ ...searchState, [key]: event.currentTarget.value },
				{ replace: true },
			),
	});
	return { searchState, updateSearch, textInput };
}
