export function tweetPermalinkPath(tweetId: string) {
	return `/tweets/${encodeURIComponent(tweetId)}`;
}

export function isTweetPermalinkPath(pathname: string) {
	return /^\/tweets\/[^/]+\/?$/.test(pathname);
}
