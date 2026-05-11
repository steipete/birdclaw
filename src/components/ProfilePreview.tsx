import type { ReactNode } from "react";
import { formatCompactNumber } from "#/lib/present";
import type { ProfileRecord } from "#/lib/types";
import {
	cx,
	profilePreviewBioClass,
	profilePreviewCardClass,
	profilePreviewClass,
	profilePreviewHandleClass,
	profilePreviewHeaderClass,
	profilePreviewMetaClass,
	profilePreviewNameClass,
	profilePreviewTriggerClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";

export function ProfilePreview({
	profile,
	children,
	className = "",
}: {
	profile: ProfileRecord;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span className={cx(profilePreviewClass, "group", className)}>
			<a
				className={profilePreviewTriggerClass}
				href={`https://x.com/${profile.handle}`}
				rel="noreferrer"
				target="_blank"
			>
				{children}
			</a>
			<span className={profilePreviewCardClass}>
				<span className={profilePreviewHeaderClass}>
					<AvatarChip
						avatarUrl={profile.avatarUrl}
						hue={profile.avatarHue}
						name={profile.displayName}
						profileId={profile.id}
					/>
					<span className="flex min-w-0 flex-col">
						<span className={profilePreviewNameClass}>
							{profile.displayName}
						</span>
						<span className={profilePreviewHandleClass}>@{profile.handle}</span>
					</span>
				</span>
				{profile.bio ? (
					<span className={profilePreviewBioClass}>{profile.bio}</span>
				) : null}
				<span className={profilePreviewMetaClass}>
					{formatCompactNumber(profile.followersCount)} followers
				</span>
			</span>
		</span>
	);
}
