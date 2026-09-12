import { useState } from "react";
import { getInitials } from "#/lib/present";
import {
	avatarChipClass,
	avatarChipLargeClass,
	avatarChipSmallClass,
	cx,
} from "#/lib/ui";

export function AvatarChip({
	profileId,
	avatarUrl,
	name,
	hue,
	size = "default",
}: {
	profileId?: string;
	avatarUrl?: string;
	name: string;
	hue: number;
	size?: "default" | "large" | "small";
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

	return (
		<span
			className={cx(
				avatarChipClass,
				size === "large" && avatarChipLargeClass,
				size === "small" && avatarChipSmallClass,
			)}
			style={{ backgroundColor: `hsl(${String(hue)} 72% 50%)` }}
		>
			{imageSrc ? (
				<img
					key={imageSrc}
					alt={name}
					className="size-full rounded-[inherit] object-cover"
					loading="lazy"
					onError={() =>
						setFailure({ source: primarySrc ?? "", attempts: attempts + 1 })
					}
					referrerPolicy="no-referrer"
					src={imageSrc}
				/>
			) : (
				getInitials(name)
			)}
		</span>
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
