export function withBirdProfileName(args: string[], profileName?: string) {
	const normalizedProfileName = profileName?.trim();
	if (!normalizedProfileName) {
		return args;
	}

	return ["--profile-name", normalizedProfileName, ...args];
}
