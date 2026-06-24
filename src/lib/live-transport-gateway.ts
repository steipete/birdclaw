import { Effect } from "effect";
import {
	getAuthenticatedBirdAccountEffect,
	listBookmarkedTweetsViaBirdEffect,
	listDirectMessagesViaBirdEffect,
	listFollowUsersViaBirdEffect,
	listHomeTimelineViaBirdEffect,
	listLikedTweetsViaBirdEffect,
	listMentionsViaBirdEffect,
	listThreadViaBirdEffect,
	listUserTweetsViaBirdEffect,
	searchTweetsViaBirdEffect,
} from "./bird";
import {
	getTransportStatus,
	getTweetByIdEffect,
	listBookmarkedTweetsViaXurl,
	listDirectMessageEventsViaXurlEffect,
	listFollowUsersViaXurl,
	listHomeTimelineViaXurlEffect,
	listLikedTweetsViaXurl,
	listMentionsViaXurl,
	listUserTweets,
	lookupAuthenticatedOAuth2UserEffect,
	lookupAuthenticatedUser,
	lookupUsersByHandles,
	searchRecentByConversationIdEffect,
	searchRecentTweetsEffect,
} from "./xurl";

export interface BirdReadTransport {
	getAuthenticatedAccount: typeof getAuthenticatedBirdAccountEffect;
	listBookmarks: typeof listBookmarkedTweetsViaBirdEffect;
	listDirectMessages: typeof listDirectMessagesViaBirdEffect;
	listFollowUsers: typeof listFollowUsersViaBirdEffect;
	listHomeTimeline: typeof listHomeTimelineViaBirdEffect;
	listLikes: typeof listLikedTweetsViaBirdEffect;
	listMentions: typeof listMentionsViaBirdEffect;
	listThread: typeof listThreadViaBirdEffect;
	listUserTweets: typeof listUserTweetsViaBirdEffect;
	searchTweets: typeof searchTweetsViaBirdEffect;
}

export interface XurlReadTransport {
	getTransportStatus(
		...args: Parameters<typeof getTransportStatus>
	): Effect.Effect<Awaited<ReturnType<typeof getTransportStatus>>, Error>;
	getTweetById: typeof getTweetByIdEffect;
	listBookmarks(
		...args: Parameters<typeof listBookmarkedTweetsViaXurl>
	): Effect.Effect<
		Awaited<ReturnType<typeof listBookmarkedTweetsViaXurl>>,
		Error
	>;
	listDirectMessages: typeof listDirectMessageEventsViaXurlEffect;
	listFollowUsers(
		...args: Parameters<typeof listFollowUsersViaXurl>
	): Effect.Effect<Awaited<ReturnType<typeof listFollowUsersViaXurl>>, Error>;
	listHomeTimeline: typeof listHomeTimelineViaXurlEffect;
	listLikes(
		...args: Parameters<typeof listLikedTweetsViaXurl>
	): Effect.Effect<Awaited<ReturnType<typeof listLikedTweetsViaXurl>>, Error>;
	listMentions(
		...args: Parameters<typeof listMentionsViaXurl>
	): Effect.Effect<Awaited<ReturnType<typeof listMentionsViaXurl>>, Error>;
	listUserTweets(
		...args: Parameters<typeof listUserTweets>
	): Effect.Effect<Awaited<ReturnType<typeof listUserTweets>>, Error>;
	lookupAuthenticatedOAuth2User: typeof lookupAuthenticatedOAuth2UserEffect;
	lookupAuthenticatedUser(
		...args: Parameters<typeof lookupAuthenticatedUser>
	): Effect.Effect<Awaited<ReturnType<typeof lookupAuthenticatedUser>>, Error>;
	lookupUsersByHandles(
		...args: Parameters<typeof lookupUsersByHandles>
	): Effect.Effect<Awaited<ReturnType<typeof lookupUsersByHandles>>, Error>;
	searchConversation: typeof searchRecentByConversationIdEffect;
	searchRecentTweets: typeof searchRecentTweetsEffect;
}

export interface LiveTransportGateway {
	bird: BirdReadTransport;
	xurl: XurlReadTransport;
}

function fromPromise<T>(run: () => PromiseLike<T>): Effect.Effect<T, Error> {
	return Effect.tryPromise({
		try: run,
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

export const liveTransportGateway: LiveTransportGateway = {
	bird: {
		getAuthenticatedAccount: (profileName) =>
			getAuthenticatedBirdAccountEffect(profileName),
		listBookmarks: (options) => listBookmarkedTweetsViaBirdEffect(options),
		listDirectMessages: (options) => listDirectMessagesViaBirdEffect(options),
		listFollowUsers: (options) => listFollowUsersViaBirdEffect(options),
		listHomeTimeline: (options) => listHomeTimelineViaBirdEffect(options),
		listLikes: (options) => listLikedTweetsViaBirdEffect(options),
		listMentions: (options) => listMentionsViaBirdEffect(options),
		listThread: (options) => listThreadViaBirdEffect(options),
		listUserTweets: (userIdOrHandle, options) =>
			listUserTweetsViaBirdEffect(userIdOrHandle, options),
		searchTweets: (query, options) => searchTweetsViaBirdEffect(query, options),
	},
	xurl: {
		getTransportStatus: (...args) =>
			fromPromise(() => getTransportStatus(...args)),
		getTweetById: (id, options) => getTweetByIdEffect(id, options),
		listBookmarks: (...args) =>
			fromPromise(() => listBookmarkedTweetsViaXurl(...args)),
		listDirectMessages: (options) =>
			listDirectMessageEventsViaXurlEffect(options),
		listFollowUsers: (...args) =>
			fromPromise(() => listFollowUsersViaXurl(...args)),
		listHomeTimeline: (options) => listHomeTimelineViaXurlEffect(options),
		listLikes: (...args) => fromPromise(() => listLikedTweetsViaXurl(...args)),
		listMentions: (...args) => fromPromise(() => listMentionsViaXurl(...args)),
		listUserTweets: (...args) => fromPromise(() => listUserTweets(...args)),
		lookupAuthenticatedOAuth2User: (username) =>
			lookupAuthenticatedOAuth2UserEffect(username),
		lookupAuthenticatedUser: (...args) =>
			fromPromise(() => lookupAuthenticatedUser(...args)),
		lookupUsersByHandles: (...args) =>
			fromPromise(() => lookupUsersByHandles(...args)),
		searchConversation: (conversationId, options) =>
			searchRecentByConversationIdEffect(conversationId, options),
		searchRecentTweets: (query, options) =>
			searchRecentTweetsEffect(query, options),
	},
};
