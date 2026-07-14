import type { Database } from "./sqlite";
import {
	createDemoPrimaryAccountMarkerValue,
	DEMO_PRIMARY_ACCOUNT,
	DEMO_PRIMARY_ACCOUNT_MARKER_KEY,
} from "./demo-account";

const now = new Date(DEMO_PRIMARY_ACCOUNT.createdAt);

function isoMinutesAgo(minutes: number) {
	return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function svgImageDataUrl(label: string, hue: number) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="hsl(${String(
		hue,
	)} 48% 42%)"/><rect x="56" y="56" width="1088" height="688" rx="42" fill="hsl(${String(
		hue + 18,
	)} 34% 18%)" opacity="0.34"/><text x="70" y="420" fill="white" font-family="Instrument Sans, sans-serif" font-size="78" font-weight="700">${label}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function svgAvatarDataUrl(label: string, hue: number) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" rx="42" fill="hsl(${String(
		hue,
	)} 54% 44%)"/><circle cx="80" cy="62" r="28" fill="rgba(255,255,255,0.22)"/><path d="M34 138c9-28 31-42 46-42s37 14 46 42" fill="rgba(255,255,255,0.22)"/><text x="80" y="98" text-anchor="middle" fill="white" font-family="Instrument Sans, sans-serif" font-size="44" font-weight="700">${label}</text></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function seedDemoData(db: Database) {
	const accountCount = db
		.prepare("select count(*) as count from accounts")
		.get() as {
		count: number;
	};

	if (accountCount.count > 0) {
		return;
	}
	const linkNow = new Date();
	const linkMinutesAgo = (minutes: number) =>
		new Date(linkNow.getTime() - minutes * 60_000).toISOString();

	const insertAccount = db.prepare(`
    insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
    values (@id, @name, @handle, @externalUserId, @transport, @isDefault, @createdAt)
  `);

	const insertProfile = db.prepare(`
    insert into profiles (id, handle, display_name, bio, followers_count, following_count, avatar_hue, avatar_url, created_at)
    values (@id, @handle, @displayName, @bio, @followersCount, @followingCount, @avatarHue, @avatarUrl, @createdAt)
  `);

	const insertTweet = db.prepare(`
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied, reply_to_id,
      like_count, media_count, entities_json, media_json, quoted_tweet_id
    ) values (
	  @id, @authorProfileId, @text, @createdAt, @isReplied, @replyToId,
	  @likeCount, @mediaCount, @entitiesJson, @mediaJson, @quotedTweetId
    )
  `);
	const insertTweetEdge = db.prepare(`
	  insert into tweet_account_edges (
	    account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
	    source, raw_json, updated_at
	  ) values (?, ?, ?, ?, ?, 1, 'demo', '{}', ?)
	`);
	const insertDemoAccountMarker = db.prepare(`
		insert or replace into sync_cache (cache_key, value_json, updated_at)
		values (?, ?, ?)
	`);
	const insertTweetCollection = db.prepare(`
	  insert into tweet_collections (
	    account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
	  ) values (?, ?, ?, ?, 'demo', '{}', ?)
	`);

	const insertConversation = db.prepare(`
    insert into dm_conversations (
      id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
    ) values (
      @id, @accountId, @participantProfileId, @title, @lastMessageAt, @unreadCount, @needsReply
    )
  `);

	const insertMessage = db.prepare(`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (
      @id, @conversationId, @senderProfileId, @text, @createdAt, @direction, @isReplied, @mediaCount
    )
  `);

	const insertTweetsFts = db.prepare(
		"insert into tweets_fts (tweet_id, text) values (?, ?)",
	);
	const insertDmFts = db.prepare(
		"insert into dm_fts (message_id, text) values (?, ?)",
	);
	const insertUrlExpansion = db.prepare(`
    insert into url_expansions (
      short_url, expanded_url, final_url, status, expanded_tweet_id,
      expanded_handle, title, description, image_url, site_name, error, source, updated_at
    ) values (
      @shortUrl, @expandedUrl, @finalUrl, @status, @expandedTweetId,
      @expandedHandle, @title, @description, @imageUrl, @siteName, @error, @source, @updatedAt
    )
  `);
	const insertLinkOccurrence = db.prepare(`
    insert into link_occurrences (
      source_kind, source_id, source_position, short_url, account_id,
      conversation_id, direction, created_at
    ) values (
      @sourceKind, @sourceId, @sourcePosition, @shortUrl, @accountId,
      @conversationId, @direction, @createdAt
    )
  `);

	const accounts = [
		{
			...DEMO_PRIMARY_ACCOUNT,
		},
		{
			id: "acct_studio",
			name: "Studio",
			handle: "@birdclaw_lab",
			externalUserId: null,
			transport: "xurl",
			isDefault: 0,
			createdAt: now.toISOString(),
		},
	];

	const profiles = [
		{
			id: "profile_me",
			handle: "steipete",
			displayName: "Peter Steinberger",
			bio: "Builds native software, tooling, and sharp little systems.",
			followersCount: 21450,
			followingCount: 0,
			avatarHue: 18,
			avatarUrl: svgAvatarDataUrl("PS", 18),
			createdAt: now.toISOString(),
		},
		{
			id: "profile_sam",
			handle: "sam",
			displayName: "Sam Altman",
			bio: "Working on AGI, energy, chips, and shipping the hard parts.",
			followersCount: 3180000,
			followingCount: 0,
			avatarHue: 210,
			avatarUrl: svgAvatarDataUrl("SA", 210),
			createdAt: now.toISOString(),
		},
		{
			id: "profile_des",
			handle: "destraynor",
			displayName: "Des Traynor",
			bio: "Intercom co-founder. Product, writing, and oddly specific opinions.",
			followersCount: 178000,
			followingCount: 0,
			avatarHue: 144,
			avatarUrl: svgAvatarDataUrl("DT", 144),
			createdAt: now.toISOString(),
		},
		{
			id: "profile_amelia",
			handle: "amelia",
			displayName: "Amelia N",
			bio: "Design systems, prototypes, and good typography over noise.",
			followersCount: 4200,
			followingCount: 0,
			avatarHue: 320,
			avatarUrl: svgAvatarDataUrl("AN", 320),
			createdAt: now.toISOString(),
		},
		{
			id: "profile_ava",
			handle: "avawires",
			displayName: "Ava Wires",
			bio: "Reports on infrastructure, AI policy, and the business of software.",
			followersCount: 632000,
			followingCount: 0,
			avatarHue: 262,
			avatarUrl: svgAvatarDataUrl("AW", 262),
			createdAt: now.toISOString(),
		},
		{
			id: "profile_noah",
			handle: "noahbuilds",
			displayName: "Noah Builds",
			bio: "Bootstrapped indie apps. Pragmatic, fast, allergic to dashboards.",
			followersCount: 12600,
			followingCount: 0,
			avatarHue: 74,
			avatarUrl: svgAvatarDataUrl("NB", 74),
			createdAt: now.toISOString(),
		},
	];

	const tweets = [
		{
			id: "tweet_001",
			accountId: "acct_primary",
			authorProfileId: "profile_sam",
			kind: "home",
			text: "We need more software that defaults to local-first, legible state, and repairable failure modes. https://t.co/local",
			createdAt: linkMinutesAgo(18),
			isReplied: 0,
			replyToId: null,
			likeCount: 1240,
			mediaCount: 0,
			bookmarked: 1,
			liked: 1,
			entitiesJson: JSON.stringify({
				urls: [
					{
						url: "https://t.co/local",
						expandedUrl: "https://birdclaw.dev/local-first-systems",
						displayUrl: "birdclaw.dev/local-first-systems",
						start: 97,
						end: 115,
						title: "Local-first systems",
						description: "Design notes on durable local software.",
					},
				],
			}),
			mediaJson: "[]",
			quotedTweetId: null,
		},
		{
			id: "tweet_002",
			accountId: "acct_primary",
			authorProfileId: "profile_des",
			kind: "home",
			text: "@sam The best product teams spend more time pruning scope than adding it.",
			createdAt: isoMinutesAgo(42),
			isReplied: 1,
			replyToId: "tweet_001",
			likeCount: 382,
			mediaCount: 0,
			bookmarked: 0,
			liked: 1,
			entitiesJson: JSON.stringify({
				mentions: [
					{
						username: "sam",
						id: "profile_sam",
						start: 0,
						end: 4,
					},
				],
			}),
			mediaJson: "[]",
			quotedTweetId: null,
		},
		{
			id: "tweet_003",
			accountId: "acct_primary",
			authorProfileId: "profile_ava",
			kind: "home",
			text: "New developer-platform pricing survey out today. Early signal: teams want fewer layers, not more. https://t.co/survey https://t.co/video",
			createdAt: linkMinutesAgo(91),
			isReplied: 0,
			replyToId: null,
			likeCount: 128,
			mediaCount: 1,
			bookmarked: 0,
			liked: 0,
			entitiesJson: JSON.stringify({
				urls: [
					{
						url: "https://t.co/survey",
						expandedUrl: "https://example.com/developer-platform-pricing",
						displayUrl: "example.com/developer-platform-pricing",
						start: 98,
						end: 117,
						title: "Developer platform pricing survey",
						description:
							"A simple inline link preview card from tweet URL entities.",
					},
					{
						url: "https://t.co/video",
						expandedUrl: "https://youtu.be/GMIWm5y90xA",
						displayUrl: "youtu.be/GMIWm5y90xA",
						start: 118,
						end: 136,
						title: "Agent query walkthrough",
						description: "Short demo video for local query workflows.",
					},
				],
			}),
			mediaJson: JSON.stringify([
				{
					url: svgImageDataUrl("pricing map", 194),
					type: "image",
					altText: "Pricing survey chart",
					width: 1200,
					height: 800,
					thumbnailUrl: svgImageDataUrl("pricing map", 194),
				},
			]),
			quotedTweetId: null,
		},
		{
			id: "tweet_004",
			accountId: "acct_primary",
			authorProfileId: "profile_amelia",
			kind: "mention",
			text: "@steipete curious how you decide when a local tool deserves a real sync engine versus manual import/export.",
			createdAt: isoMinutesAgo(12),
			isReplied: 0,
			replyToId: null,
			likeCount: 14,
			mediaCount: 0,
			bookmarked: 0,
			liked: 0,
			entitiesJson: JSON.stringify({
				mentions: [
					{
						username: "steipete",
						id: "profile_me",
						start: 0,
						end: 9,
					},
				],
			}),
			mediaJson: "[]",
			quotedTweetId: null,
		},
		{
			id: "tweet_005",
			accountId: "acct_primary",
			authorProfileId: "profile_noah",
			kind: "mention",
			text: "@steipete your archive-first note resonated. I still want a path for people with zero clean export data.",
			createdAt: isoMinutesAgo(54),
			isReplied: 1,
			replyToId: null,
			likeCount: 8,
			mediaCount: 0,
			bookmarked: 0,
			liked: 0,
			entitiesJson: JSON.stringify({
				mentions: [
					{
						username: "steipete",
						id: "profile_me",
						start: 0,
						end: 9,
					},
				],
			}),
			mediaJson: "[]",
			quotedTweetId: null,
		},
		{
			id: "tweet_006",
			accountId: "acct_studio",
			authorProfileId: "profile_sam",
			kind: "home",
			text: "Agents need retrieval surfaces with small, stable contracts. Big blobs are not a strategy.",
			createdAt: isoMinutesAgo(77),
			isReplied: 0,
			replyToId: null,
			likeCount: 912,
			mediaCount: 0,
			bookmarked: 1,
			liked: 1,
			entitiesJson: JSON.stringify({
				urls: [
					{
						url: "https://t.co/quoted",
						expandedUrl: "https://x.com/sam/status/tweet_001",
						displayUrl: "x.com/sam/status/tweet_001",
						start: 58,
						end: 81,
						title: "Quoted tweet",
						description: "Local quoted tweet expansion",
					},
				],
			}),
			mediaJson: "[]",
			quotedTweetId: "tweet_001",
		},
	];

	const conversations = [
		{
			id: "dm_001",
			accountId: "acct_primary",
			participantProfileId: "profile_sam",
			title: "Sam Altman",
			lastMessageAt: isoMinutesAgo(8),
			unreadCount: 1,
			needsReply: 1,
		},
		{
			id: "dm_002",
			accountId: "acct_primary",
			participantProfileId: "profile_des",
			title: "Des Traynor",
			lastMessageAt: isoMinutesAgo(65),
			unreadCount: 0,
			needsReply: 0,
		},
		{
			id: "dm_003",
			accountId: "acct_primary",
			participantProfileId: "profile_amelia",
			title: "Amelia N",
			lastMessageAt: isoMinutesAgo(25),
			unreadCount: 2,
			needsReply: 1,
		},
		{
			id: "dm_004",
			accountId: "acct_studio",
			participantProfileId: "profile_ava",
			title: "Ava Wires",
			lastMessageAt: isoMinutesAgo(130),
			unreadCount: 0,
			needsReply: 0,
		},
	];

	const messages = [
		{
			id: "msg_001",
			conversationId: "dm_001",
			senderProfileId: "profile_sam",
			text: "Can you send the local-first sync sketch? The inbox angle is strong.",
			createdAt: isoMinutesAgo(8),
			direction: "inbound",
			isReplied: 0,
			mediaCount: 0,
		},
		{
			id: "msg_002",
			conversationId: "dm_001",
			senderProfileId: "profile_me",
			text: "Yep. I am tightening the transport boundary first, then I will send the schema.",
			createdAt: isoMinutesAgo(27),
			direction: "outbound",
			isReplied: 1,
			mediaCount: 0,
		},
		{
			id: "msg_003",
			conversationId: "dm_002",
			senderProfileId: "profile_des",
			text: "The minimal UI direction feels right. People should read, not manage a cockpit.",
			createdAt: isoMinutesAgo(65),
			direction: "inbound",
			isReplied: 1,
			mediaCount: 0,
		},
		{
			id: "msg_004",
			conversationId: "dm_002",
			senderProfileId: "profile_me",
			text: "Exactly. Dense signal, quiet chrome, clear action lanes.",
			createdAt: isoMinutesAgo(58),
			direction: "outbound",
			isReplied: 1,
			mediaCount: 0,
		},
		{
			id: "msg_005",
			conversationId: "dm_003",
			senderProfileId: "profile_amelia",
			text: "I mocked a cleaner split-pane DM layout. Want me to send it over?",
			createdAt: isoMinutesAgo(25),
			direction: "inbound",
			isReplied: 0,
			mediaCount: 1,
		},
		{
			id: "msg_006",
			conversationId: "dm_003",
			senderProfileId: "profile_amelia",
			text: "Also added a tiny context rail for bios and follower counts.",
			createdAt: isoMinutesAgo(22),
			direction: "inbound",
			isReplied: 0,
			mediaCount: 0,
		},
		{
			id: "msg_007",
			conversationId: "dm_004",
			senderProfileId: "profile_ava",
			text: "If you have a public draft later, I would love to quote the agent-query angle.",
			createdAt: isoMinutesAgo(130),
			direction: "inbound",
			isReplied: 1,
			mediaCount: 0,
		},
		{
			id: "msg_008",
			conversationId: "dm_004",
			senderProfileId: "profile_me",
			text: "Will do. I want the filters and local storage story to be credible first.",
			createdAt: isoMinutesAgo(124),
			direction: "outbound",
			isReplied: 1,
			mediaCount: 0,
		},
	];

	const urlExpansions = [
		{
			shortUrl: "https://t.co/local",
			expandedUrl: "https://birdclaw.dev/local-first-systems",
			finalUrl: "https://birdclaw.dev/local-first-systems",
			status: "hit",
			expandedTweetId: null,
			expandedHandle: null,
			title: "Local-first systems",
			description: "Design notes on durable local software.",
			imageUrl: null,
			siteName: "birdclaw",
			error: null,
			source: "demo",
			updatedAt: linkNow.toISOString(),
		},
		{
			shortUrl: "https://t.co/survey",
			expandedUrl: "https://example.com/developer-platform-pricing",
			finalUrl: "https://example.com/developer-platform-pricing",
			status: "hit",
			expandedTweetId: null,
			expandedHandle: null,
			title: "Developer platform pricing survey",
			description: "A simple inline link preview card from tweet URL entities.",
			imageUrl: null,
			siteName: "Example",
			error: null,
			source: "demo",
			updatedAt: linkNow.toISOString(),
		},
		{
			shortUrl: "https://t.co/video",
			expandedUrl: "https://youtu.be/GMIWm5y90xA",
			finalUrl: "https://youtu.be/GMIWm5y90xA",
			status: "hit",
			expandedTweetId: null,
			expandedHandle: null,
			title: "Agent query walkthrough",
			description: "Short demo video for local query workflows.",
			imageUrl: null,
			siteName: "YouTube",
			error: null,
			source: "demo",
			updatedAt: linkNow.toISOString(),
		},
	];

	const linkOccurrences = [
		{
			sourceKind: "tweet",
			sourceId: "tweet_001",
			sourcePosition: 0,
			shortUrl: "https://t.co/local",
			accountId: "acct_primary",
			conversationId: null,
			direction: null,
			createdAt: linkMinutesAgo(18),
		},
		{
			sourceKind: "tweet",
			sourceId: "tweet_003",
			sourcePosition: 0,
			shortUrl: "https://t.co/survey",
			accountId: "acct_primary",
			conversationId: null,
			direction: null,
			createdAt: linkMinutesAgo(91),
		},
		{
			sourceKind: "tweet",
			sourceId: "tweet_003",
			sourcePosition: 1,
			shortUrl: "https://t.co/video",
			accountId: "acct_primary",
			conversationId: null,
			direction: null,
			createdAt: linkMinutesAgo(91),
		},
	];

	const transaction = db.transaction(() => {
		for (const account of accounts) {
			insertAccount.run(account);
		}

		for (const profile of profiles) {
			insertProfile.run(profile);
		}

		for (const tweet of tweets) {
			insertTweet.run({
				id: tweet.id,
				authorProfileId: tweet.authorProfileId,
				text: tweet.text,
				createdAt: tweet.createdAt,
				isReplied: tweet.isReplied,
				replyToId: tweet.replyToId,
				likeCount: tweet.likeCount,
				mediaCount: tweet.mediaCount,
				entitiesJson: tweet.entitiesJson,
				mediaJson: tweet.mediaJson,
				quotedTweetId: tweet.quotedTweetId,
			});
			insertTweetEdge.run(
				tweet.accountId,
				tweet.id,
				tweet.kind,
				tweet.createdAt,
				tweet.createdAt,
				tweet.createdAt,
			);
			if (tweet.bookmarked) {
				insertTweetCollection.run(
					tweet.accountId,
					tweet.id,
					"bookmarks",
					tweet.createdAt,
					tweet.createdAt,
				);
			}
			if (tweet.liked) {
				insertTweetCollection.run(
					tweet.accountId,
					tweet.id,
					"likes",
					tweet.createdAt,
					tweet.createdAt,
				);
			}
			insertTweetsFts.run(tweet.id, tweet.text);
		}

		for (const conversation of conversations) {
			insertConversation.run(conversation);
		}

		for (const message of messages) {
			insertMessage.run(message);
			insertDmFts.run(message.id, message.text);
		}

		for (const expansion of urlExpansions) {
			insertUrlExpansion.run(expansion);
		}

		for (const occurrence of linkOccurrences) {
			insertLinkOccurrence.run(occurrence);
		}

		insertDemoAccountMarker.run(
			DEMO_PRIMARY_ACCOUNT_MARKER_KEY,
			createDemoPrimaryAccountMarkerValue(db),
			DEMO_PRIMARY_ACCOUNT.createdAt,
		);
	});

	transaction();
}
