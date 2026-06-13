import {
	Fragment,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { formatCompactNumber } from "#/lib/present";
import {
	collectTweetSegmentsForText,
	profileDescriptionEntitiesFromXurl,
} from "#/lib/tweet-render";
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
	tweetLinkClass,
} from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";
import { AvatarChip } from "./AvatarChip";

type VerticalBounds = { top: number; bottom: number };

function nearestVerticalClipBounds(element: HTMLElement): VerticalBounds {
	let top = 0;
	let bottom = window.innerHeight;
	for (
		let current = element.parentElement;
		current;
		current = current.parentElement
	) {
		const style = window.getComputedStyle(current);
		if (!/(auto|scroll|hidden|clip)/.test(style.overflowY)) continue;
		const rect = current.getBoundingClientRect();
		top = Math.max(top, rect.top);
		bottom = Math.min(bottom, rect.bottom);
	}
	return { top, bottom };
}

function ProfilePreviewBio({ profile }: { profile: ProfileRecord }) {
	const segments = collectTweetSegmentsForText(
		profile.bio,
		profileDescriptionEntitiesFromXurl(profile.entities),
	);
	let cursor = 0;

	return (
		<span className={profilePreviewBioClass}>
			{segments.map((segment, index) => {
				if (
					segment.kind !== "url" ||
					segment.start < cursor ||
					segment.end <= segment.start ||
					segment.end > profile.bio.length
				) {
					return null;
				}
				const prefix = profile.bio.slice(cursor, segment.start);
				cursor = segment.end;
				const href = safeHttpUrl(segment.expandedUrl);
				return (
					<Fragment key={`${segment.url}-${String(index)}`}>
						{prefix}
						{href ? (
							<a
								className={tweetLinkClass}
								href={href}
								rel="noreferrer"
								target="_blank"
							>
								{segment.expandedUrl}
							</a>
						) : (
							profile.bio.slice(segment.start, segment.end)
						)}
					</Fragment>
				);
			})}
			{profile.bio.slice(cursor)}
		</span>
	);
}

export function ProfilePreview({
	profile,
	children,
	className = "",
}: {
	profile: ProfileRecord;
	children: ReactNode;
	className?: string;
}) {
	const [placeAbove, setPlaceAbove] = useState(false);
	const shellRef = useRef<HTMLSpanElement | null>(null);
	const cardRef = useRef<HTMLSpanElement | null>(null);

	function updatePlacement() {
		const shell = shellRef.current;
		if (!shell) return;
		const shellRect = shell.getBoundingClientRect();
		const card = cardRef.current;
		const cardRect = card?.getBoundingClientRect();
		const cardHeight = Math.max(
			card?.offsetHeight ?? 0,
			cardRect?.height ?? 0,
			180,
		);
		const bounds = nearestVerticalClipBounds(shell);
		const belowSpace = bounds.bottom - shellRect.bottom;
		const aboveSpace = shellRect.top - bounds.top;
		setPlaceAbove(belowSpace < cardHeight + 18 && aboveSpace >= belowSpace);
	}

	useLayoutEffect(() => {
		updatePlacement();
		const frame = window.requestAnimationFrame(updatePlacement);
		return () => window.cancelAnimationFrame(frame);
	}, []);

	return (
		<span
			ref={shellRef}
			className={cx(profilePreviewClass, "group", className)}
			onFocus={updatePlacement}
			onPointerEnter={updatePlacement}
		>
			<a
				className={profilePreviewTriggerClass}
				href={`/profiles/${encodeURIComponent(profile.handle)}`}
			>
				{children}
			</a>
			<span
				ref={cardRef}
				className={cx(
					profilePreviewCardClass,
					placeAbove
						? "bottom-[calc(100%+8px)] -translate-y-1 group-hover:translate-y-0 group-focus-within:translate-y-0"
						: "top-[calc(100%+8px)] translate-y-1 group-hover:translate-y-0 group-focus-within:translate-y-0",
				)}
			>
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
				{profile.bio ? <ProfilePreviewBio profile={profile} /> : null}
				<span className={profilePreviewMetaClass}>
					{formatCompactNumber(profile.followersCount)} followers
				</span>
			</span>
		</span>
	);
}
