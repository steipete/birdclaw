import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ArchiveImportPlan } from "../archive-import-plan";
import {
	ARCHIVE_DELETION_REASON,
	ARCHIVE_DELETION_SOURCE,
	editHistoryIdsFromPayload,
} from "../tweet-retention";
import {
	asArray,
	asRecord,
	extractTweetEntities,
	extractTweetMedia,
	getTweetMediaCount,
	parseTwitterDate,
	toInt,
} from "./parsing";
import { processArchiveEntryRecordsEffect } from "./reader";
import type { ImportProgressEvent } from "./types";

interface ParseTweetSliceParams {
	archivePath: string;
	entries: string[];
	plan: ArchiveImportPlan;
	onProgress: (event: ImportProgressEvent) => void;
}

export function parseTweetSliceEffect({
	archivePath,
	entries,
	plan,
	onProgress,
}: ParseTweetSliceParams) {
	return Effect.gen(function* () {
		if (entries.length > 0) {
			onProgress({
				kind: "slice-start",
				slice: "tweets",
				files: entries.length,
			});
		}
		for (const [fileIndex, entry] of entries.entries()) {
			yield* processArchiveEntryRecordsEffect(archivePath, entry, (wrapper) => {
				const tweet = asRecord(wrapper.tweet);
				if (!tweet) return;

				for (const mention of asArray<Record<string, unknown>>(
					asRecord(tweet.entities)?.user_mentions,
				)) {
					const mentionId = String(mention.id_str ?? mention.id ?? "");
					if (!mentionId) continue;
					plan.mentionDirectory.set(mentionId, {
						handle: String(mention.screen_name ?? ""),
						displayName: String(
							mention.name ?? mention.screen_name ?? mentionId,
						),
					});
				}

				const replyUserId = String(
					tweet.in_reply_to_user_id_str ?? tweet.in_reply_to_user_id ?? "",
				);
				const replyScreenName = String(tweet.in_reply_to_screen_name ?? "");
				if (replyUserId && replyScreenName) {
					plan.mentionDirectory.set(replyUserId, {
						handle: replyScreenName,
						displayName: replyScreenName,
					});
				}

				plan.addTweet({
					id: String(tweet.id_str ?? tweet.id),
					kind: "home",
					authorProfileId: "profile_me",
					text: String(tweet.full_text ?? tweet.text ?? ""),
					createdAt: parseTwitterDate(tweet.created_at),
					isReplied: tweet.in_reply_to_status_id_str ? 1 : 0,
					replyToId: tweet.in_reply_to_status_id_str
						? String(tweet.in_reply_to_status_id_str)
						: null,
					likeCount: toInt(tweet.favorite_count),
					mediaCount: getTweetMediaCount(tweet),
					bookmarked: 0,
					liked: 0,
					entitiesJson: JSON.stringify(extractTweetEntities(tweet)),
					mediaJson: JSON.stringify(extractTweetMedia(tweet)),
					quotedTweetId: tweet.quoted_status_id_str
						? String(tweet.quoted_status_id_str)
						: null,
					editHistoryIds: editHistoryIdsFromPayload(
						String(tweet.id_str ?? tweet.id),
						tweet,
					),
					rawJson: JSON.stringify(tweet),
				});
			});
			onProgress({
				kind: "slice-file",
				slice: "tweets",
				processed: fileIndex + 1,
				files: entries.length,
			});
		}
		if (entries.length > 0) {
			onProgress({
				kind: "slice-done",
				slice: "tweets",
				count: plan.tweets.length,
			});
		}
	});
}

export function parseDeletedTweetSliceEffect({
	archivePath,
	entries,
	plan,
	onProgress,
	observedAt,
}: ParseTweetSliceParams & { observedAt: string }) {
	return Effect.gen(function* () {
		if (entries.length > 0) {
			onProgress({
				kind: "slice-start",
				slice: "deletedTweets",
				files: entries.length,
			});
		}
		const rowsBefore = plan.tweets.length;
		for (const [fileIndex, entry] of entries.entries()) {
			const isHeaderFile =
				/(?:^|\/)deleted-tweet-headers(?:-part\d+)?\.js$/i.test(entry);
			yield* processArchiveEntryRecordsEffect(archivePath, entry, (wrapper) => {
				const deletedTweet = asRecord(
					wrapper.deletedTweet ??
						wrapper.deleted_tweet ??
						wrapper.deletedTweetHeader ??
						wrapper.deleted_tweet_header ??
						wrapper.tweetHeader ??
						wrapper.tweet_header ??
						wrapper.tweet,
				);
				if (!deletedTweet) return;
				const id = String(
					deletedTweet.id_str ??
						deletedTweet.id ??
						deletedTweet.tweetId ??
						deletedTweet.tweet_id ??
						"",
				);
				if (!id) return;
				const explicitDeletedAt = String(
					deletedTweet.deleted_at ?? deletedTweet.deletedAt ?? "",
				).trim();
				const createdAtValue =
					deletedTweet.created_at ?? deletedTweet.createdAt;
				plan.addTweet({
					id,
					kind: "home",
					authorProfileId: "profile_me",
					text: String(deletedTweet.full_text ?? deletedTweet.text ?? ""),
					createdAt: createdAtValue
						? parseTwitterDate(createdAtValue)
						: new Date(0).toISOString(),
					isReplied: deletedTweet.in_reply_to_status_id_str ? 1 : 0,
					replyToId: deletedTweet.in_reply_to_status_id_str
						? String(deletedTweet.in_reply_to_status_id_str)
						: null,
					likeCount: toInt(deletedTweet.favorite_count),
					mediaCount: getTweetMediaCount(deletedTweet),
					bookmarked: 0,
					liked: 0,
					entitiesJson: JSON.stringify(extractTweetEntities(deletedTweet)),
					mediaJson: JSON.stringify(extractTweetMedia(deletedTweet)),
					quotedTweetId: deletedTweet.quoted_status_id_str
						? String(deletedTweet.quoted_status_id_str)
						: null,
					deletedAt: explicitDeletedAt || observedAt,
					deletionSource: ARCHIVE_DELETION_SOURCE,
					deletionReason: ARCHIVE_DELETION_REASON,
					editHistoryIds: editHistoryIdsFromPayload(id, deletedTweet),
					rawJson: isHeaderFile ? null : JSON.stringify(deletedTweet),
				});
			});
			onProgress({
				kind: "slice-file",
				slice: "deletedTweets",
				processed: fileIndex + 1,
				files: entries.length,
			});
		}
		if (entries.length > 0) {
			onProgress({
				kind: "slice-done",
				slice: "deletedTweets",
				count: plan.tweets.length - rowsBefore,
			});
		}
	});
}

export function parseNoteTweetSliceEffect({
	archivePath,
	entries,
	plan,
	onProgress,
}: ParseTweetSliceParams) {
	return Effect.gen(function* () {
		if (entries.length > 0) {
			onProgress({
				kind: "slice-start",
				slice: "noteTweets",
				files: entries.length,
			});
		}
		const rowsBefore = plan.tweets.length;
		for (const [fileIndex, entry] of entries.entries()) {
			yield* processArchiveEntryRecordsEffect(archivePath, entry, (wrapper) => {
				const noteTweet = asRecord(wrapper.noteTweet);
				if (!noteTweet) return;
				const core = asRecord(noteTweet.core);
				plan.addTweet({
					id: String(noteTweet.noteTweetId ?? noteTweet.id ?? randomUUID()),
					kind: "home",
					authorProfileId: "profile_me",
					text: String(core?.text ?? ""),
					createdAt: parseTwitterDate(noteTweet.createdAt),
					isReplied: 0,
					replyToId: null,
					likeCount: 0,
					mediaCount: 0,
					bookmarked: 0,
					liked: 0,
					entitiesJson: "{}",
					mediaJson: "[]",
					quotedTweetId: null,
					editHistoryIds: [
						String(noteTweet.noteTweetId ?? noteTweet.id ?? ""),
					].filter(Boolean),
					rawJson: JSON.stringify(noteTweet),
				});
			});
			onProgress({
				kind: "slice-file",
				slice: "noteTweets",
				processed: fileIndex + 1,
				files: entries.length,
			});
		}
		if (entries.length > 0) {
			onProgress({
				kind: "slice-done",
				slice: "noteTweets",
				count: plan.tweets.length - rowsBefore,
			});
		}
	});
}
