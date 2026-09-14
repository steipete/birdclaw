export function parsePerfFixturePath(argument: string | undefined) {
	if (argument !== undefined && !argument.trim())
		throw new Error(
			"Expected a non-empty fixture path or '-' for a generated fixture",
		);
	return argument === "-" ? undefined : argument;
}
