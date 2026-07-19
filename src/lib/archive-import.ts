import { Effect } from "effect";
import { ArchiveImportPlan } from "./archive-import-plan";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { getImportRepository } from "./import-repository";
import { applyArchiveImportPlanEffect } from "./archive/apply";
import { parseCollectionSliceEffect } from "./archive/collection-slice";
import { parseDirectMessagesEffect } from "./archive/dm-slice";
import {
	parseFollowSliceEffect,
	reconcileFollowProfiles,
} from "./archive/follow-slice";
import { createArchiveProfileReconciler } from "./archive/profile-reconciler";
import {
	parseDeletedTweetSliceEffect,
	parseNoteTweetSliceEffect,
	parseTweetSliceEffect,
} from "./archive/tweet-slices";
import {
	extractArchiveMediaFilesEffect,
	selectedArchiveMediaKinds,
} from "./archive/media";
import {
	asArray,
	asRecord,
	buildAccountPayload,
	compareIsoTimestamp,
	extractCollectionTweet,
	extractTweetEntities,
	extractTweetMedia,
	getTweetMediaCount,
	inferProfileFromDirectory,
	parseTwitterDate,
	toInt,
} from "./archive/parsing";
import {
	extractArchiveJson,
	getFirstEntry,
	getMatchingEntries,
	listArchiveEntriesEffect,
	normalizeArchivePath,
	parseArchiveArray,
	readArchiveEntryEffect,
} from "./archive/reader";
import {
	includesSlice,
	selectArchiveSliceEntries,
	selectedSlices,
} from "./archive/slices";
import type {
	ImportedArchiveSummary,
	ImportArchiveOptions,
} from "./archive/types";

export {
	ARCHIVE_IMPORT_SLICES,
	type ArchiveImportSlice,
	type ImportArchiveOptions,
	type ImportProgressEvent,
	type ImportProgressSlice,
	type ImportWritePhase,
} from "./archive/types";

function importArchiveInternalEffect(
	archivePath: string,
	options: ImportArchiveOptions = {},
): Effect.Effect<ImportedArchiveSummary, unknown> {
	return Effect.gen(function* () {
		const onProgress = options.onProgress ?? (() => {});
		const observedAt = new Date().toISOString();
		const entries = yield* listArchiveEntriesEffect(archivePath);
		onProgress({ kind: "scanned", entryCount: entries.length });
		const selection = selectedSlices(options);
		const includeTweets = includesSlice(selection, "tweets");
		const includeLikes = includesSlice(selection, "likes");
		const includeBookmarks = includesSlice(selection, "bookmarks");
		const includeDirectMessages = includesSlice(selection, "directMessages");
		const includeProfiles = includesSlice(selection, "profiles");
		const includeFollowers = includesSlice(selection, "followers");
		const includeFollowing = includesSlice(selection, "following");
		const {
			accountEntry,
			profileEntry,
			tweetEntries,
			deletedTweetEntries,
			noteTweetEntries,
			likeEntries,
			bookmarkEntries,
			dmEntries,
			followerEntries,
			followingEntries,
		} = selectArchiveSliceEntries(entries, selection);

		if (!accountEntry) {
			return yield* Effect.fail(new Error("Archive missing data/account.js"));
		}

		const [accountContent, profileContent] = yield* Effect.all([
			readArchiveEntryEffect(archivePath, accountEntry),
			profileEntry
				? readArchiveEntryEffect(archivePath, profileEntry)
				: Effect.succeed("[]"),
		]);

		const accountPayload = buildAccountPayload(
			parseArchiveArray(accountContent)[0] ?? null,
			parseArchiveArray(profileContent)[0] ?? null,
		);
		const db = getNativeDb({ seedDemoData: false });
		const repository = getImportRepository(db);
		const plan = new ArchiveImportPlan();
		const {
			tweets: tweetRows,
			profiles,
			conversations,
			dmMessages,
			followers: followerRows,
			following: followingRows,
		} = plan;

		yield* parseTweetSliceEffect({
			archivePath,
			entries: tweetEntries,
			plan,
			onProgress,
		});
		yield* parseDeletedTweetSliceEffect({
			archivePath,
			entries: deletedTweetEntries,
			plan,
			onProgress,
			observedAt,
		});
		yield* parseNoteTweetSliceEffect({
			archivePath,
			entries: noteTweetEntries,
			plan,
			onProgress,
		});
		const authoredTweetCount = tweetRows.length;

		const profileReconciler = createArchiveProfileReconciler({
			repository,
			selection,
			preserveExisting: !(
				options.restore === true &&
				(!selection || selection.has("profiles"))
			),
			allowAccountReplacement: options.restore === true && !selection,
			accountPayload,
			profiles,
		});
		profileReconciler.assertAccountMatchesArchive();
		const localProfile =
			profileReconciler.initializeLocalProfile(includeProfiles);
		yield* parseDirectMessagesEffect({
			archivePath,
			entries: dmEntries,
			db,
			selection,
			accountPayload,
			localProfile,
			plan,
			profileReconciler,
			onProgress,
		});

		const likeCount = yield* parseCollectionSliceEffect({
			archivePath,
			entries: likeEntries,
			kind: "like",
			plan,
			onProgress,
		});
		const bookmarkCount = yield* parseCollectionSliceEffect({
			archivePath,
			entries: bookmarkEntries,
			kind: "bookmark",
			plan,
			onProgress,
		});
		onProgress({ kind: "slice-start", slice: "media", files: 0 });
		const mediaFileCounts = yield* extractArchiveMediaFilesEffect(
			archivePath,
			selectedArchiveMediaKinds(selection),
		);
		onProgress({
			kind: "slice-done",
			slice: "media",
			count: Object.values(mediaFileCounts).reduce(
				(total, value) => total + value,
				0,
			),
		});

		yield* parseFollowSliceEffect({
			archivePath,
			entries: followerEntries,
			direction: "followers",
			plan,
			onProgress,
		});
		yield* parseFollowSliceEffect({
			archivePath,
			entries: followingEntries,
			direction: "following",
			plan,
			onProgress,
		});
		reconcileFollowProfiles({
			plan,
			reconciler: profileReconciler,
			includeFollowers,
			includeFollowing,
			followerEntryCount: followerEntries.length,
			followingEntryCount: followingEntries.length,
		});

		if (
			tweetRows.some((tweet) => tweet.authorProfileId === "profile_unknown")
		) {
			profileReconciler.ensureUnknownProfile();
		}

		yield* applyArchiveImportPlanEffect({
			archivePath,
			db,
			repository,
			selection,
			includeTweets,
			includeLikes,
			includeBookmarks,
			includeDirectMessages,
			includeProfiles,
			includeFollowers,
			includeFollowing,
			accountPayload,
			localProfile,
			plan,
			resolveProfileId: profileReconciler.resolveId,
			followerEntryCount: followerEntries.length,
			followingEntryCount: followingEntries.length,
			onProgress,
			restore: options.restore === true,
		});
		onProgress({ kind: "done" });

		return {
			ok: true,
			mode: options.restore === true ? "restore" : "merge",
			archivePath,
			account: {
				id: accountPayload.accountId,
				handle: accountPayload.username,
				displayName: accountPayload.displayName,
			},
			counts: {
				tweets: authoredTweetCount,
				likes: likeCount,
				bookmarks: bookmarkCount,
				dmConversations: conversations.size,
				dmMessages: dmMessages.length,
				profiles: profiles.size,
				mediaFiles: mediaFileCounts,
				followers: followerRows.length,
				following: followingRows.length,
			},
		};
	});
}

export function importArchiveEffect(
	archivePath: string,
	options: ImportArchiveOptions = {},
): Effect.Effect<ImportedArchiveSummary, unknown> {
	return importArchiveInternalEffect(archivePath, options);
}

export function importArchive(
	archivePath: string,
	options: ImportArchiveOptions = {},
): Promise<ImportedArchiveSummary> {
	return runEffectPromise(importArchiveEffect(archivePath, options));
}

export const __test__ = {
	normalizeArchivePath,
	extractArchiveJson,
	parseArchiveArray,
	getFirstEntry,
	getMatchingEntries,
	parseTwitterDate,
	asRecord,
	asArray,
	toInt,
	compareIsoTimestamp,
	getTweetMediaCount,
	extractTweetEntities,
	extractTweetMedia,
	extractCollectionTweet,
	buildAccountPayload,
	inferProfileFromDirectory,
};
