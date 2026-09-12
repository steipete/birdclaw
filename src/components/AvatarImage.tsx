import { type ReactNode, useState } from "react";

export function AvatarImage({
	profileId,
	avatarUrl,
	alt,
	className = "size-full rounded-[inherit] object-cover",
	fallback,
}: {
	profileId?: string;
	avatarUrl?: string;
	alt: string;
	className?: string;
	fallback: ReactNode;
}) {
	const avatarSrc =
		profileId && avatarUrl ? avatarPath(profileId, avatarUrl) : null;
	const remoteSrc = remoteAvatarUrl(avatarUrl);
	const primarySrc = avatarSrc ?? remoteSrc;
	const [failure, setFailure] = useState({ source: "", attempts: 0 });
	const attempts = failure.source === primarySrc ? failure.attempts : 0;
	const imageSrc =
		attempts === 0
			? primarySrc
			: attempts === 1 && avatarSrc
				? remoteSrc
				: null;

	return imageSrc ? (
		<img
			key={imageSrc}
			alt={alt}
			className={className}
			loading="lazy"
			onError={() =>
				setFailure({ source: primarySrc ?? "", attempts: attempts + 1 })
			}
			referrerPolicy="no-referrer"
			src={imageSrc}
		/>
	) : (
		fallback
	);
}

function remoteAvatarUrl(value: string | undefined) {
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
