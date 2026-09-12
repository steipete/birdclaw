import { type CSSProperties, useState } from "react";
import { avatarPath, remoteAvatarUrl } from "#/lib/avatar-url";
import { getInitials } from "#/lib/present";
import {
	avatarChipClass,
	avatarChipLargeClass,
	avatarChipMapClass,
	avatarChipSmallClass,
	cx,
} from "#/lib/ui";

export function AvatarChip({
	profileId,
	avatarUrl,
	name,
	hue = 210,
	variant = "default",
	size = variant === "map" ? 36 : "default",
	className,
	style,
}: {
	profileId?: string;
	avatarUrl?: string;
	name: string;
	hue?: number;
	size?: "default" | "large" | "small" | number;
	variant?: "default" | "map";
	className?: string;
	style?: CSSProperties;
}) {
	const cachedSrc =
		profileId && avatarUrl ? avatarPath(profileId, avatarUrl) : null;
	const remoteSrc = remoteAvatarUrl(avatarUrl);
	const primarySrc = cachedSrc ?? remoteSrc;
	const isMap = variant === "map";

	return (
		<span
			className={cx(
				isMap ? avatarChipMapClass : avatarChipClass,
				size === "large" && avatarChipLargeClass,
				size === "small" && avatarChipSmallClass,
				className,
			)}
			style={{
				backgroundColor: isMap ? undefined : `hsl(${String(hue)} 72% 50%)`,
				...(typeof size === "number" && { width: size, height: size }),
				...style,
			}}
		>
			<AvatarContent
				key={primarySrc}
				primarySrc={primarySrc}
				fallbackSrc={cachedSrc ? remoteSrc : null}
				alt={isMap ? "" : name}
				initials={isMap ? name.slice(0, 1).toUpperCase() : getInitials(name)}
			/>
		</span>
	);
}

function AvatarContent({
	primarySrc,
	fallbackSrc,
	alt,
	initials,
}: {
	primarySrc: string | null;
	fallbackSrc: string | null;
	alt: string;
	initials: string;
}) {
	const [src, setSrc] = useState(primarySrc);
	return src ? (
		<img
			key={src}
			alt={alt}
			className="size-full rounded-[inherit] object-cover"
			loading="lazy"
			onError={() => setSrc(src === primarySrc ? fallbackSrc : null)}
			referrerPolicy="no-referrer"
			src={src}
		/>
	) : (
		initials
	);
}
