import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type {
	ArchiveImportPlan,
	ArchiveProfileRow,
} from "../archive-import-plan";
import { databaseWriteEffect } from "../database-writer";
import type { ImportRepository } from "../import-repository";
import type { Database } from "../sqlite";
import {
	reconcileTweetTombstones,
	recordTweetRevision,
	tombstoneTweetSubordinates,
} from "../tweet-retention";
import type {
	ArchiveAccountPayload,
	ArchiveFollowDirection,
	ArchiveImportSlice,
	ImportProgressEvent,
	ImportWritePhase,
} from "./types";

interface ApplyArchiveImportParams {
	archivePath: string;
	db: Database;
	repository: ImportRepository;
	selection: Set<ArchiveImportSlice> | null;
	includeTweets: boolean;
	includeLikes: boolean;
	includeBookmarks: boolean;
	includeDirectMessages: boolean;
	includeProfiles: boolean;
	includeFollowers: boolean;
	includeFollowing: boolean;
	accountPayload: ArchiveAccountPayload;
	localProfile: ArchiveProfileRow;
	plan: ArchiveImportPlan;
	resolveProfileId: (profileId: string) => string;
	followerEntryCount: number;
	followingEntryCount: number;
	onProgress: (event: ImportProgressEvent) => void;
	restore: boolean;
}

export function applyArchiveImportPlanEffect({
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
	resolveProfileId,
	followerEntryCount,
	followingEntryCount,
	onProgress,
	restore,
}: ApplyArchiveImportParams) {
	const {
		tweets: tweetRows,
		collections: collectionRows,
		profiles,
		conversations,
		dmMessages,
		followers: followerRows,
		following: followingRows,
	} = plan;

	return Effect.gen(function* () {
		const insertAccount = db.prepare(`
		    insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
		    values (?, ?, ?, ?, ?, 1, ?)
		    on conflict(id) do update set
		      name = excluded.name,
		      handle = excluded.handle,
		      external_user_id = excluded.external_user_id,
		      transport = excluded.transport,
		      is_default = 1,
		      created_at = excluded.created_at
		  `);
		const insertAccountIfMissing = db.prepare(`
		    insert or ignore into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
		    values (?, ?, ?, ?, ?, 1, ?)
		  `);
		const insertProfile = db.prepare(`
			    insert into profiles (
			      id, handle, display_name, bio, followers_count, following_count,
			      public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
			      entities_json, raw_json, created_at
			    )
			    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		      on conflict(id) do update set
		        handle = excluded.handle,
		        display_name = excluded.display_name,
		        bio = excluded.bio,
		        followers_count = excluded.followers_count,
		        following_count = excluded.following_count,
		        public_metrics_json = excluded.public_metrics_json,
		        avatar_hue = excluded.avatar_hue,
		        avatar_url = excluded.avatar_url,
		        location = excluded.location,
		        url = excluded.url,
		        verified_type = excluded.verified_type,
		        entities_json = excluded.entities_json,
		        raw_json = excluded.raw_json,
		        created_at = excluded.created_at
			  `);
		const insertProfileIfMissing = db.prepare(`
			    insert or ignore into profiles (
			      id, handle, display_name, bio, followers_count, following_count,
			      public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
			      entities_json, raw_json, created_at
			    )
			    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			  `);
		const insertTweet = db.prepare(`
		    insert into tweets (
		      id, author_profile_id, text, created_at, is_replied, reply_to_id,
		      like_count, media_count, entities_json, media_json, quoted_tweet_id,
		      deleted_at, deletion_source, deletion_reason
		    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		    on conflict(id) do update set
		      author_profile_id = case
		        when tweets.author_profile_id = 'profile_unknown' then excluded.author_profile_id
		        else tweets.author_profile_id
		      end,
			      text = case
			        when ? = 1 and tweets.text <> ''
			          then tweets.text
			        when excluded.text <> '' then excluded.text
			        else tweets.text
			      end,
			      created_at = case
			        when ? = 1 then tweets.created_at
			        else excluded.created_at
			      end,
		      is_replied = max(tweets.is_replied, excluded.is_replied),
		      reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
		      like_count = max(tweets.like_count, excluded.like_count),
		      media_count = max(tweets.media_count, excluded.media_count),
		      entities_json = case when excluded.entities_json <> '{}' then excluded.entities_json else tweets.entities_json end,
		      media_json = case when excluded.media_json <> '[]' then excluded.media_json else tweets.media_json end,
		      quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id),
		      deleted_at = case
		        when tweets.deleted_at is null then excluded.deleted_at
		        when excluded.deleted_at is null then tweets.deleted_at
		        else min(tweets.deleted_at, excluded.deleted_at)
		      end,
		      deletion_source = coalesce(tweets.deletion_source, excluded.deletion_source),
		      deletion_reason = coalesce(tweets.deletion_reason, excluded.deletion_reason)
		  `);
		const deleteTweetFts = db.prepare(
			"delete from tweets_fts where tweet_id = ?",
		);
		const insertTweetFts = db.prepare(
			"insert into tweets_fts (tweet_id, text) values (?, ?)",
		);
		const selectTweetFtsState = db.prepare(
			"select text, deleted_at from tweets where id = ?",
		);
		const insertTimelineEdge = db.prepare(`
		    insert into tweet_account_edges (
		      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count, source,
		      raw_json, updated_at
		    ) values (?, ?, ?, ?, ?, 1, 'archive', '{}', ?)
		    on conflict(account_id, tweet_id, kind) do update set
		      first_seen_at = min(tweet_account_edges.first_seen_at, excluded.first_seen_at),
		      last_seen_at = max(tweet_account_edges.last_seen_at, excluded.last_seen_at),
		      updated_at = max(tweet_account_edges.updated_at, excluded.updated_at)
		  `);
		const insertCollection = db.prepare(`
		    insert into tweet_collections (
		      account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
		    ) values (?, ?, ?, ?, ?, ?, ?)
		    on conflict(account_id, tweet_id, kind) do update set
		      collected_at = coalesce(excluded.collected_at, tweet_collections.collected_at),
		      source = case
		        when tweet_collections.source = 'archive' then excluded.source
		        else tweet_collections.source
		      end,
		      raw_json = case
		        when tweet_collections.source = 'archive' then excluded.raw_json
		        else tweet_collections.raw_json
		      end,
		      updated_at = max(tweet_collections.updated_at, excluded.updated_at)
			  `);
		const insertConversation = db.prepare(`
		    insert into dm_conversations (
		      id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
		    ) values (?, ?, ?, ?, ?, ?, ?)
		    on conflict(id) do update set
		      participant_profile_id = excluded.participant_profile_id,
		      title = excluded.title,
		      last_message_at = max(dm_conversations.last_message_at, excluded.last_message_at),
		      unread_count = max(dm_conversations.unread_count, excluded.unread_count),
		      needs_reply = max(dm_conversations.needs_reply, excluded.needs_reply)
		  `);
		const insertMessage = db.prepare(`
		    insert into dm_messages (
		      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
		    ) values (?, ?, ?, ?, ?, ?, ?, ?)
		    on conflict(id) do update set
		      conversation_id = excluded.conversation_id,
		      sender_profile_id = excluded.sender_profile_id,
		      text = excluded.text,
		      created_at = excluded.created_at,
		      direction = excluded.direction,
		      is_replied = max(dm_messages.is_replied, excluded.is_replied),
		      media_count = max(dm_messages.media_count, excluded.media_count)
		  `);
		const insertDmFts = db.prepare(
			"insert into dm_fts (message_id, text) values (?, ?)",
		);
		const deleteDmFts = db.prepare("delete from dm_fts where message_id = ?");
		const insertFollowSnapshot = db.prepare(`
		    insert into follow_snapshots (
		      id, account_id, direction, source, status, page_count, result_count,
		      started_at, completed_at, raw_meta_json
		    ) values (?, ?, ?, 'archive', ?, ?, ?, ?, ?, ?)
		    on conflict(id) do update set
		      account_id = excluded.account_id,
		      direction = excluded.direction,
		      source = excluded.source,
		      status = excluded.status,
		      page_count = excluded.page_count,
		      result_count = excluded.result_count,
		      started_at = excluded.started_at,
		      completed_at = excluded.completed_at,
		      raw_meta_json = excluded.raw_meta_json
		  `);
		const insertFollowSnapshotMember = db.prepare(`
		    insert into follow_snapshot_members (
		      snapshot_id, profile_id, external_user_id, position
		    ) values (?, ?, ?, ?)
		  `);
		const selectFollowSnapshotMembers = db.prepare(`
		    select profile_id, external_user_id
		    from follow_snapshot_members
		    where snapshot_id = ?
		    order by position, profile_id
		  `);
		const deleteFollowSnapshotMembers = db.prepare(
			"delete from follow_snapshot_members where snapshot_id = ?",
		);
		const deleteArchiveFollowEvents = db.prepare(`
		    delete from follow_events
		    where account_id = ? and direction = ? and (
		      snapshot_id = ? or snapshot_id in (
		        select id from follow_snapshots
		        where account_id = ? and direction = ? and source = 'archive'
		      )
		    )
		  `);
		const deleteArchiveFollowSnapshotMembers = db.prepare(`
		    delete from follow_snapshot_members
		    where snapshot_id in (
		      select id from follow_snapshots
		      where account_id = ? and direction = ? and source = 'archive'
		    )
		  `);
		const deleteArchiveFollowSnapshots = db.prepare(`
		    delete from follow_snapshots
		    where account_id = ? and direction = ? and source = 'archive'
		  `);
		const deleteArchiveFollowEdges = db.prepare(`
		    delete from follow_edges
		    where account_id = ? and direction = ? and source = 'archive'
		  `);
		const selectFollowEdges = db.prepare(`
		    select profile_id, external_user_id, current
		    from follow_edges
		    where account_id = ? and direction = ?
		  `);
		const insertFollowEdge = db.prepare(`
		    insert into follow_edges (
		      account_id, direction, profile_id, external_user_id, source, current,
		      first_seen_at, last_seen_at, ended_at, updated_at
		    ) values (?, ?, ?, ?, 'archive', 1, ?, ?, null, ?)
		    on conflict(account_id, direction, profile_id) do update set
		      external_user_id = excluded.external_user_id,
		      source = case
		        when follow_edges.source = 'archive' then excluded.source
		        else follow_edges.source
		      end,
		      current = 1,
		      last_seen_at = excluded.last_seen_at,
		      ended_at = null,
		      updated_at = excluded.updated_at
		  `);
		const endFollowEdge = db.prepare(`
		    update follow_edges
		    set current = 0, ended_at = ?, updated_at = ?
		    where account_id = ? and direction = ? and profile_id = ?
		  `);
		const insertFollowEvent = db.prepare(`
		    insert into follow_events (
		      id, account_id, direction, profile_id, external_user_id, kind, event_at, snapshot_id
		    ) values (?, ?, ?, ?, ?, ?, ?, ?)
		  `);
		const clearSelectedLikes = db.prepare(`
			    delete from tweet_collections
			    where account_id = ? and kind = 'likes' and source in ('archive', 'legacy')
			  `);
		const clearSelectedBookmarks = db.prepare(`
			    delete from tweet_collections
			    where account_id = ? and kind = 'bookmarks' and source in ('archive', 'legacy')
			  `);
		const clearSelectedArchiveTweetEdges = db.prepare(`
				    delete from tweet_account_edges
				    where account_id = ?
			      and kind in ('home', 'authored')
			      and (
			        source = 'archive'
			        or (
				          source = 'legacy'
				          and exists (
				            select 1
				            from tweets
				            where tweets.id = tweet_account_edges.tweet_id
				              and tweets.author_profile_id = ?
			          )
			        )
			      )
			  `);
		const deleteOrphanTweetLinkOccurrences = db.prepare(`
			    delete from link_occurrences
			    where source_kind = 'tweet'
				      and source_id not in (select id from tweets)
				  `);
		const deleteOrphanTweets = db.prepare(`
			    delete from tweets
			    where not exists (
			        select 1
			        from tweet_collections collection
		        where collection.tweet_id = tweets.id
		      )
		      and not exists (
			        select 1
				        from tweet_account_edges edge
				        where edge.tweet_id = tweets.id
				      )
				      and not exists (
				        select 1
				        from tweets referencing_tweet
				        where referencing_tweet.reply_to_id = tweets.id
				          or referencing_tweet.quoted_tweet_id = tweets.id
				      )
				  `);
		const deleteOrphanTweetFts = db.prepare(`
		    delete from tweets_fts
		    where tweet_id not in (select id from tweets)
		  `);
		const deleteOrphanTweetSubordinateTombstones = db.prepare(`
		    delete from tweet_subordinate_tombstones
		    where tweet_id not in (select id from tweets)
		  `);
		const deleteOrphanTweetRevisionChains = db.prepare(`
		    delete from tweet_revisions
		    where root_tweet_id in (
		      select revisions.root_tweet_id
		      from tweet_revisions revisions
		      group by revisions.root_tweet_id
		      having not exists (
		        select 1
		        from tweet_revisions retained_revision
		        join tweets on tweets.id = retained_revision.revision_id
		        where retained_revision.root_tweet_id = revisions.root_tweet_id
		      )
		    )
		  `);
		const clearDmFts = db.prepare(`
		    delete from dm_fts
		    where message_id in (
		      select m.id
		      from dm_messages m
		      join dm_conversations c on c.id = m.conversation_id
		      where c.account_id = ?
		    )
		  `);
		const clearDmLinkOccurrences = db.prepare(`
		    delete from link_occurrences
		    where source_kind = 'dm'
		      and source_id in (
		        select m.id
		        from dm_messages m
		        join dm_conversations c on c.id = m.conversation_id
		        where c.account_id = ?
		      )
		  `);
		const clearDmMessages = db.prepare(`
		    delete from dm_messages
		    where conversation_id in (
		      select id from dm_conversations where account_id = ?
		    )
		  `);
		const clearDmConversations = db.prepare(
			"delete from dm_conversations where account_id = ?",
		);

		function importFollowRows(
			direction: ArchiveFollowDirection,
			rows: Array<{ profileId: string; externalUserId: string }>,
			entryCount: number,
			now: string,
		) {
			const snapshotId = `follow_snapshot_archive_acct_primary_${direction}`;
			const existingEdges = new Map(
				(
					selectFollowEdges.all("acct_primary", direction) as Array<{
						profile_id: string;
						external_user_id: string;
						current: number;
					}>
				).map((row) => [row.profile_id, row]),
			);
			const existingMembers = selectFollowSnapshotMembers.all(
				snapshotId,
			) as Array<{
				profile_id: string;
				external_user_id: string;
			}>;
			const incomingRows = rows.map((row) => ({
				profileId: resolveProfileId(row.profileId),
				externalUserId: row.externalUserId,
			}));
			const effectiveRows = restore
				? incomingRows
				: [
						...existingMembers.map((row) => ({
							profileId: row.profile_id,
							externalUserId: row.external_user_id,
						})),
						...incomingRows.filter(
							(row) =>
								!existingMembers.some(
									(member) => member.profile_id === row.profileId,
								),
						),
					];
			const existingMemberKey = existingMembers
				.map(
					(row, index) =>
						`${String(index)}:${row.profile_id}:${row.external_user_id}`,
				)
				.join("\n");
			const nextMemberKey = effectiveRows
				.map(
					(row, index) =>
						`${String(index)}:${row.profileId}:${row.externalUserId}`,
				)
				.join("\n");
			const membersChanged = existingMemberKey !== nextMemberKey;
			const currentProfileIds = new Set<string>();

			insertFollowSnapshot.run(
				snapshotId,
				"acct_primary",
				direction,
				restore ? "complete" : "partial",
				entryCount,
				effectiveRows.length,
				now,
				now,
				JSON.stringify({
					archivePath,
					result_count: incomingRows.length,
					merged_result_count: effectiveRows.length,
				}),
			);

			if (membersChanged) {
				deleteFollowSnapshotMembers.run(snapshotId);
			}
			effectiveRows.forEach((row, index) => {
				const profileId = row.profileId;
				if (membersChanged) {
					insertFollowSnapshotMember.run(
						snapshotId,
						profileId,
						row.externalUserId,
						index,
					);
				}
			});
			incomingRows.forEach((row) => {
				const profileId = row.profileId;
				currentProfileIds.add(profileId);

				const previous = existingEdges.get(profileId);
				insertFollowEdge.run(
					"acct_primary",
					direction,
					profileId,
					row.externalUserId,
					now,
					now,
					now,
				);
				if (!previous || previous.current === 0) {
					insertFollowEvent.run(
						`follow_event_${randomUUID()}`,
						"acct_primary",
						direction,
						profileId,
						row.externalUserId,
						"started",
						now,
						snapshotId,
					);
				}
			});

			if (!restore) return;
			for (const [profileId, previous] of existingEdges) {
				if (previous.current === 0 || currentProfileIds.has(profileId)) {
					continue;
				}
				endFollowEdge.run(now, now, "acct_primary", direction, profileId);
				insertFollowEvent.run(
					`follow_event_${randomUUID()}`,
					"acct_primary",
					direction,
					profileId,
					previous.external_user_id,
					"ended",
					now,
					snapshotId,
				);
			}
		}

		function clearArchiveFollowRows(direction: ArchiveFollowDirection) {
			deleteArchiveFollowEvents.run(
				"acct_primary",
				direction,
				`follow_snapshot_archive_acct_primary_${direction}`,
				"acct_primary",
				direction,
			);
			deleteArchiveFollowSnapshotMembers.run("acct_primary", direction);
			deleteArchiveFollowSnapshots.run("acct_primary", direction);
			deleteArchiveFollowEdges.run("acct_primary", direction);
		}

		onProgress({ kind: "writing" });
		const WRITE_PROGRESS_INTERVAL = 1000;
		function tickWrite(
			phase: ImportWritePhase,
			processed: number,
			total: number,
		) {
			if (processed === total || processed % WRITE_PROGRESS_INTERVAL === 0) {
				onProgress({ kind: "write-progress", phase, processed, total });
			}
		}
		yield* databaseWriteEffect(() => {
			if (restore && !selection) {
				repository.clearArchiveImport();
				repository.clearMentionSyncState();
			}

			if (restore && selection) {
				if (includeTweets) {
					repository.clearAuthoredSyncCursors("acct_primary");
					clearSelectedArchiveTweetEdges.run("acct_primary", localProfile.id);
				}
				if (includeLikes) {
					clearSelectedLikes.run("acct_primary");
				}
				if (includeBookmarks) {
					clearSelectedBookmarks.run("acct_primary");
				}
				if (includeTweets || includeLikes || includeBookmarks) {
					deleteOrphanTweets.run();
					deleteOrphanTweetFts.run();
					deleteOrphanTweetLinkOccurrences.run();
					deleteOrphanTweetSubordinateTombstones.run();
					deleteOrphanTweetRevisionChains.run();
				}
				if (includeDirectMessages) {
					clearDmLinkOccurrences.run("acct_primary");
					clearDmFts.run("acct_primary");
					clearDmMessages.run("acct_primary");
					clearDmConversations.run("acct_primary");
				}
			}

			const writeAccount = selection ? insertAccountIfMissing : insertAccount;
			writeAccount.run(
				"acct_primary",
				accountPayload.displayName,
				`@${accountPayload.username}`,
				accountPayload.accountId,
				"archive",
				accountPayload.createdAt,
			);

			const writeProfile =
				!selection || includeProfiles ? insertProfile : insertProfileIfMissing;
			const importedAt = new Date().toISOString();
			const profilesTotal = profiles.size;
			if (profilesTotal > 0) {
				onProgress({
					kind: "write-start",
					phase: "profiles",
					total: profilesTotal,
				});
			}
			let profileIndex = 0;
			for (const profile of profiles.values()) {
				writeProfile.run(
					profile.id,
					profile.handle,
					profile.displayName,
					profile.bio,
					profile.followersCount,
					profile.followingCount,
					profile.publicMetricsJson,
					profile.avatarHue,
					profile.avatarUrl,
					profile.location,
					profile.url,
					profile.verifiedType,
					profile.entitiesJson,
					profile.rawJson,
					profile.createdAt,
				);
				profileIndex += 1;
				tickWrite("profiles", profileIndex, profilesTotal);
			}

			if (tweetRows.length > 0) {
				onProgress({
					kind: "write-start",
					phase: "tweets",
					total: tweetRows.length,
				});
			}
			let tweetWriteIndex = 0;
			for (const tweet of tweetRows) {
				const preserveExistingBody =
					Boolean(tweet.deletedAt) ||
					tweet.kind === "like" ||
					tweet.kind === "bookmark";
				const authorProfileId =
					tweet.authorProfileId === "profile_me"
						? localProfile.id
						: resolveProfileId(tweet.authorProfileId);
				insertTweet.run(
					tweet.id,
					authorProfileId,
					tweet.text,
					tweet.createdAt,
					tweet.isReplied,
					tweet.replyToId,
					tweet.likeCount,
					tweet.mediaCount,
					tweet.entitiesJson,
					tweet.mediaJson,
					tweet.quotedTweetId,
					tweet.deletedAt ?? null,
					tweet.deletionSource ?? null,
					tweet.deletionReason ?? null,
					preserveExistingBody ? 1 : 0,
					preserveExistingBody ? 1 : 0,
				);
				deleteTweetFts.run(tweet.id);
				if (tweet.kind === "home") {
					insertTimelineEdge.run(
						"acct_primary",
						tweet.id,
						tweet.kind,
						tweet.createdAt,
						tweet.createdAt,
						new Date().toISOString(),
					);
				}
				if (authorProfileId === localProfile.id) {
					insertTimelineEdge.run(
						"acct_primary",
						tweet.id,
						"authored",
						tweet.createdAt,
						tweet.createdAt,
						new Date().toISOString(),
					);
				}
				const storedTweet = selectTweetFtsState.get(tweet.id) as
					| { text: string; deleted_at: string | null }
					| undefined;
				if (!storedTweet?.deleted_at) {
					insertTweetFts.run(tweet.id, storedTweet?.text ?? tweet.text);
				} else {
					tombstoneTweetSubordinates(db, {
						tweetId: tweet.id,
						deletedAt: storedTweet.deleted_at,
						deletionSource: tweet.deletionSource ?? "archive_import",
					});
				}
				recordTweetRevision(db, {
					tweetId: tweet.id,
					editHistoryIds: tweet.editHistoryIds ?? [tweet.id],
					payloadJson: tweet.rawJson ?? null,
					source: "twitter_archive",
					observedAt: importedAt,
				});
				tweetWriteIndex += 1;
				tickWrite("tweets", tweetWriteIndex, tweetRows.length);
			}

			if (collectionRows.length > 0) {
				onProgress({
					kind: "write-start",
					phase: "collections",
					total: collectionRows.length,
				});
			}
			let collectionIndex = 0;
			for (const collection of collectionRows) {
				insertCollection.run(
					"acct_primary",
					collection.tweetId,
					collection.kind,
					collection.collectedAt,
					collection.source,
					collection.rawJson,
					importedAt,
				);
				collectionIndex += 1;
				tickWrite("collections", collectionIndex, collectionRows.length);
			}

			for (const conversation of conversations.values()) {
				insertConversation.run(
					conversation.id,
					conversation.accountId,
					conversation.participantProfileId,
					conversation.title,
					conversation.lastMessageAt,
					conversation.unreadCount,
					conversation.needsReply,
				);
			}

			if (dmMessages.length > 0) {
				onProgress({
					kind: "write-start",
					phase: "dmMessages",
					total: dmMessages.length,
				});
			}
			let dmWriteIndex = 0;
			for (const message of dmMessages) {
				insertMessage.run(
					message.id,
					message.conversationId,
					message.senderProfileId,
					message.text,
					message.createdAt,
					message.direction,
					message.direction === "outbound" ? 1 : 0,
					message.mediaCount,
				);
				deleteDmFts.run(message.id);
				insertDmFts.run(message.id, message.text);
				dmWriteIndex += 1;
				tickWrite("dmMessages", dmWriteIndex, dmMessages.length);
			}

			if (includeFollowers && followerEntryCount > 0) {
				importFollowRows(
					"followers",
					followerRows,
					followerEntryCount,
					importedAt,
				);
			} else if (includeFollowers && restore) {
				clearArchiveFollowRows("followers");
			}
			if (includeFollowing && followingEntryCount > 0) {
				importFollowRows(
					"following",
					followingRows,
					followingEntryCount,
					importedAt,
				);
			} else if (includeFollowing && restore) {
				clearArchiveFollowRows("following");
			}
			reconcileTweetTombstones(db);
		}, db);
	});
}
