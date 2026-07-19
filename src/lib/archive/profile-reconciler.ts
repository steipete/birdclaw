import type { ArchiveProfileRow } from "../archive-import-plan";
import type { ImportRepository } from "../import-repository";
import type {
	ArchiveAccountPayload,
	ArchiveFollowDirection,
	ArchiveImportSlice,
} from "./types";

export const defaultArchiveProfileMetadata = {
	publicMetricsJson: "{}",
	location: null,
	url: null,
	verifiedType: null,
	entitiesJson: "{}",
	rawJson: "{}",
} as const;

type ExistingProfileRow = {
	id: string;
	handle: string;
	display_name: string;
	bio: string;
	followers_count: number;
	following_count: number;
	public_metrics_json: string;
	avatar_hue: number;
	avatar_url: string | null;
	location: string | null;
	url: string | null;
	verified_type: string | null;
	entities_json: string;
	raw_json: string;
	created_at: string;
};

type ArchiveProfileTier =
	| "archive_follow_stub"
	| "archive_dm_stub"
	| "archive_mention_inferred"
	| "live_or_hydrated";

const archiveProfileTierRank: Record<ArchiveProfileTier, number> = {
	archive_follow_stub: 0,
	archive_dm_stub: 1,
	archive_mention_inferred: 2,
	live_or_hydrated: 3,
};

function classifyProfile(profile: ArchiveProfileRow): ArchiveProfileTier {
	const externalUserId = profile.id.startsWith("profile_user_")
		? profile.id.slice("profile_user_".length)
		: "";
	const fallbackHandle = externalUserId ? `id${externalUserId}` : profile.id;
	const hasLiveSignals =
		profile.followersCount > 0 ||
		profile.followingCount > 0 ||
		profile.publicMetricsJson.trim() !== "{}" ||
		profile.avatarUrl !== null ||
		profile.location !== null ||
		profile.url !== null ||
		profile.verifiedType !== null ||
		profile.entitiesJson.trim() !== "{}" ||
		profile.rawJson.trim() !== "{}";

	if (hasLiveSignals) return "live_or_hydrated";
	if (
		profile.handle === fallbackHandle &&
		profile.displayName === "" &&
		profile.bio === ""
	) {
		return "archive_follow_stub";
	}
	if (profile.bio.startsWith("Imported from archive user ")) {
		return profile.handle === fallbackHandle &&
			profile.displayName === fallbackHandle
			? "archive_dm_stub"
			: "archive_mention_inferred";
	}
	return profile.handle === fallbackHandle && profile.displayName === ""
		? "archive_follow_stub"
		: "archive_mention_inferred";
}

function shouldPreserveProfile(
	existingTier: ArchiveProfileTier,
	incomingTier: ArchiveProfileTier,
) {
	return (
		archiveProfileTierRank[existingTier] >= archiveProfileTierRank[incomingTier]
	);
}

function existingProfileToProfileRow(
	profile: ExistingProfileRow,
): ArchiveProfileRow {
	return {
		id: profile.id,
		handle: profile.handle,
		displayName: profile.display_name,
		bio: profile.bio,
		followersCount: profile.followers_count,
		followingCount: profile.following_count,
		publicMetricsJson: profile.public_metrics_json,
		avatarHue: profile.avatar_hue,
		avatarUrl: profile.avatar_url,
		location: profile.location,
		url: profile.url,
		verifiedType: profile.verified_type,
		entitiesJson: profile.entities_json,
		rawJson: profile.raw_json,
		createdAt: profile.created_at,
	};
}

export function createArchiveProfileReconciler({
	repository,
	selection,
	preserveExisting = true,
	allowAccountReplacement = false,
	accountPayload,
	profiles,
}: {
	repository: ImportRepository;
	selection: Set<ArchiveImportSlice> | null;
	preserveExisting?: boolean;
	allowAccountReplacement?: boolean;
	accountPayload: ArchiveAccountPayload;
	profiles: Map<string, ArchiveProfileRow>;
}) {
	const existingProfiles = new Map(
		repository
			.readRows<ExistingProfileRow>(`
        select id, handle, display_name, bio, followers_count, following_count,
          public_metrics_json, avatar_hue, avatar_url, location, url,
          verified_type, entities_json, raw_json, created_at
        from profiles
      `)
			.map((profile) => [profile.id, profile]),
	);
	const existingProfilesByHandle = new Map(
		[...existingProfiles.values()].map((profile) => [
			profile.handle.toLowerCase(),
			profile,
		]),
	);
	const existingPrimaryAccount = repository.readRow<{
		handle: string;
		external_user_id: string | null;
	}>(
		"select handle, external_user_id from accounts where id = ?",
		"acct_primary",
	);
	const profileIdAliases = new Map<string, string>();

	function merge(incoming: ArchiveProfileRow) {
		const existingById = preserveExisting
			? existingProfiles.get(incoming.id)
			: undefined;
		const existingByHandle = preserveExisting
			? existingProfilesByHandle.get(incoming.handle.toLowerCase())
			: undefined;
		const targetExisting = existingById ?? existingByHandle;
		const targetId = targetExisting?.id ?? incoming.id;
		if (targetId !== incoming.id) profileIdAliases.set(incoming.id, targetId);
		const targetIncoming =
			targetId === incoming.id ? incoming : { ...incoming, id: targetId };
		const incomingTier = classifyProfile(incoming);
		const current = profiles.get(targetId);
		const currentTier = current ? classifyProfile(current) : null;
		const existingProfile = targetExisting
			? existingProfileToProfileRow(targetExisting)
			: null;
		const existingTier = existingProfile
			? classifyProfile(existingProfile)
			: null;

		if (
			current &&
			currentTier &&
			shouldPreserveProfile(currentTier, incomingTier) &&
			(!existingTier || shouldPreserveProfile(currentTier, existingTier))
		) {
			return;
		}
		if (
			existingProfile &&
			existingTier &&
			shouldPreserveProfile(existingTier, incomingTier)
		) {
			profiles.set(targetId, existingProfile);
			return;
		}
		profiles.set(targetId, targetIncoming);
	}

	function resolveId(profileId: string) {
		return profileIdAliases.get(profileId) ?? profileId;
	}

	function isHandleTakenByOtherId(handle: string, profileId: string) {
		const normalizedHandle = handle.toLowerCase();
		const existingProfile = existingProfilesByHandle.get(normalizedHandle);
		if (existingProfile && existingProfile.id !== profileId) return true;
		return [...profiles.values()].some(
			(profile) =>
				profile.id !== profileId &&
				profile.handle.toLowerCase() === normalizedHandle,
		);
	}

	function uniqueHandle(baseHandle: string, profileId: string) {
		if (!isHandleTakenByOtherId(baseHandle, profileId)) return baseHandle;
		let index = 1;
		while (true) {
			const suffix = index === 1 ? "archive" : `archive_${index}`;
			const candidate = `${baseHandle}_${suffix}`;
			if (!isHandleTakenByOtherId(candidate, profileId)) return candidate;
			index += 1;
		}
	}

	function addFollowProfile(profileId: string, externalUserId: string) {
		if (!profileId) return;
		const fallbackId =
			externalUserId || profileId.replace(/^profile_user_/, "");
		merge({
			id: profileId,
			handle: fallbackId ? `id${fallbackId}` : profileId,
			displayName: "",
			bio: "",
			followersCount: 0,
			followingCount: 0,
			...defaultArchiveProfileMetadata,
			avatarHue: 210,
			avatarUrl: null,
			createdAt: accountPayload.createdAt,
		});
	}

	function assertAccountMatchesArchive() {
		if (allowAccountReplacement || !existingPrimaryAccount) return;
		const existingExternalUserId = existingPrimaryAccount.external_user_id;
		if (
			existingExternalUserId &&
			existingExternalUserId !== accountPayload.accountId
		) {
			throw new Error(
				`Existing acct_primary (${existingExternalUserId}) does not match archive account ${accountPayload.accountId}`,
			);
		}
		const existingHandle = existingPrimaryAccount.handle
			.replace(/^@/, "")
			.toLowerCase();
		if (
			!existingExternalUserId &&
			existingHandle !== accountPayload.username.toLowerCase()
		) {
			throw new Error(
				`Existing acct_primary (@${existingHandle}) does not match archive account @${accountPayload.username}`,
			);
		}
	}

	function initializeLocalProfile(includeProfiles: boolean) {
		const existingLocalProfile =
			preserveExisting &&
			(existingProfiles.get("profile_me") ??
				[...existingProfiles.values()].find(
					(profile) =>
						profile.handle.toLowerCase() ===
						accountPayload.username.toLowerCase(),
				));
		const archivedLocalProfile = existingLocalProfile
			? {
					...existingProfileToProfileRow(existingLocalProfile),
					handle: accountPayload.username,
					displayName: accountPayload.displayName,
					bio: accountPayload.bio,
					createdAt: accountPayload.createdAt,
				}
			: {
					id: "profile_me",
					handle: accountPayload.username,
					displayName: accountPayload.displayName,
					bio: accountPayload.bio,
					followersCount: 0,
					followingCount: 0,
					...defaultArchiveProfileMetadata,
					avatarHue: 18,
					avatarUrl: null,
					createdAt: accountPayload.createdAt,
				};
		const localProfile =
			existingLocalProfile && !includeProfiles
				? existingProfileToProfileRow(existingLocalProfile)
				: archivedLocalProfile;
		profiles.set(localProfile.id, localProfile);
		return localProfile;
	}

	function retainExistingFollowProfiles(
		clearedDirections: Set<ArchiveFollowDirection>,
	) {
		const retained = repository.readRows<{
			direction: ArchiveFollowDirection;
			profile_id: string;
			external_user_id: string;
			source: string | null;
			snapshot_id: string | null;
			snapshot_source: string | null;
		}>(`
      select direction, profile_id, external_user_id, source, null as snapshot_id, null as snapshot_source
      from follow_edges
      union
      select ev.direction, ev.profile_id, ev.external_user_id, null as source, ev.snapshot_id, snap.source as snapshot_source
      from follow_events ev
      left join follow_snapshots snap on snap.id = ev.snapshot_id
      `);
		for (const row of retained) {
			const clearedArchiveRow =
				clearedDirections.has(row.direction) &&
				(row.source === "archive" ||
					row.snapshot_source === "archive" ||
					row.snapshot_id ===
						`follow_snapshot_archive_acct_primary_${row.direction}`);
			if (!clearedArchiveRow)
				addFollowProfile(row.profile_id, row.external_user_id);
		}
	}

	function ensureUnknownProfile() {
		const unknownProfile: ArchiveProfileRow = {
			id: "profile_unknown",
			handle: selection
				? uniqueHandle("unknown", "profile_unknown")
				: "unknown",
			displayName: "Unknown",
			bio: "Imported from archive collection metadata",
			followersCount: 0,
			followingCount: 0,
			...defaultArchiveProfileMetadata,
			avatarHue: 210,
			avatarUrl: null,
			createdAt: accountPayload.createdAt,
		};
		const existing = existingProfiles.get("profile_unknown");
		profiles.set(
			"profile_unknown",
			existing ? existingProfileToProfileRow(existing) : unknownProfile,
		);
	}

	return {
		merge,
		resolveId,
		uniqueHandle,
		addFollowProfile,
		assertAccountMatchesArchive,
		initializeLocalProfile,
		retainExistingFollowProfiles,
		ensureUnknownProfile,
	};
}

export type ArchiveProfileReconciler = ReturnType<
	typeof createArchiveProfileReconciler
>;
