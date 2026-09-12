import { AvatarImage } from "./AvatarImage";
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
	return (
		<span
			className={cx(
				avatarChipClass,
				size === "large" && avatarChipLargeClass,
				size === "small" && avatarChipSmallClass,
			)}
			style={{ backgroundColor: `hsl(${String(hue)} 72% 50%)` }}
		>
			<AvatarImage
				profileId={profileId}
				avatarUrl={avatarUrl}
				alt={name}
				fallback={getInitials(name)}
			/>
		</span>
	);
}
