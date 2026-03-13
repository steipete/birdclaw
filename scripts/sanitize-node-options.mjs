export function sanitizeNodeOptions(value) {
	if (!value?.trim()) {
		return undefined;
	}

	const sanitized = value
		.split(/\s+/)
		.filter((part) => part && !part.startsWith("--localstorage-file"))
		.join(" ")
		.trim();

	return sanitized || undefined;
}

export function withSanitizedNodeOptions(env = process.env) {
	const nodeOptions = sanitizeNodeOptions(env.NODE_OPTIONS);
	return {
		...env,
		...(nodeOptions
			? { NODE_OPTIONS: nodeOptions }
			: { NODE_OPTIONS: undefined }),
	};
}
