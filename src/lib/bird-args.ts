export function withBirdProfileName(args: string[], profileName: string) {
	const normalizedProfileName = profileName.trim();
	if (!normalizedProfileName) {
		throw new Error(
			"bird_profile_name is required to use bird; run birdclaw accounts set-bird-profile first",
		);
	}

	return ["--profile-name", normalizedProfileName, ...args];
}
