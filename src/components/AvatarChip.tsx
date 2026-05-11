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
		profileId && avatarUrl
			? `/api/avatar?profileId=${encodeURIComponent(profileId)}`
			: null;
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const showImage = avatarSrc && failedSrc !== avatarSrc;

	return (
		<span
			className={cx(
				avatarChipClass,
				size === "large" && avatarChipLargeClass,
				size === "small" && avatarChipSmallClass,
			)}
			style={{ backgroundColor: `hsl(${String(hue)} 72% 50%)` }}
		>
			{showImage ? (
				<img
					alt={name}
					className="size-full rounded-[inherit] object-cover"
					loading="lazy"
					onError={() => setFailedSrc(avatarSrc)}
					src={avatarSrc}
				/>
			) : (
				getInitials(name)
			)}
		</span>
	);
}
