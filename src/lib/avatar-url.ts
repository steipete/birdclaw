export function remoteAvatarUrl(value: string | undefined) {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "pbs.twimg.com" ||
			url.port ||
			url.username ||
			url.password ||
			!url.pathname.startsWith("/profile_images/")
		)
			return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function avatarPath(profileId: string, avatarUrl: string) {
	const query = new URLSearchParams({
		profileId,
		v: avatarUrl,
	});
	return `/api/avatar?${query.toString()}`;
}
