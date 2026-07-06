import {
	getAuthenticatedBirdAccountEffect,
	listBookmarkedTweetsViaBirdEffect,
	listDirectMessagesViaBirdEffect,
	listFollowUsersViaBirdEffect,
	listHomeTimelineViaBirdEffect,
	listLikedTweetsViaBirdEffect,
	listMentionsViaBirdEffect,
	listThreadViaBirdEffect,
	searchTweetsViaBirdEffect,
} from "./bird";
import {
	getTransportStatusEffect,
	getTweetByIdEffect,
	listBookmarkedTweetsViaXurlEffect,
	listDirectMessageEventsViaXurlEffect,
	listFollowUsersViaXurlEffect,
	listHomeTimelineViaXurlEffect,
	listLikedTweetsViaXurlEffect,
	listMentionsViaXurlEffect,
	listUserTweetsEffect,
	lookupAuthenticatedOAuth2UserEffect,
	lookupAuthenticatedUserEffect,
	lookupUsersByHandlesEffect,
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
	searchTweets: typeof searchTweetsViaBirdEffect;
}

export interface XurlReadTransport {
	getTransportStatus: typeof getTransportStatusEffect;
	getTweetById: typeof getTweetByIdEffect;
	listBookmarks: typeof listBookmarkedTweetsViaXurlEffect;
	listDirectMessages: typeof listDirectMessageEventsViaXurlEffect;
	listFollowUsers: typeof listFollowUsersViaXurlEffect;
	listHomeTimeline: typeof listHomeTimelineViaXurlEffect;
	listLikes: typeof listLikedTweetsViaXurlEffect;
	listMentions: typeof listMentionsViaXurlEffect;
	listUserTweets: typeof listUserTweetsEffect;
	lookupAuthenticatedOAuth2User: typeof lookupAuthenticatedOAuth2UserEffect;
	lookupAuthenticatedUser: typeof lookupAuthenticatedUserEffect;
	lookupUsersByHandles: typeof lookupUsersByHandlesEffect;
	searchConversation: typeof searchRecentByConversationIdEffect;
	searchRecentTweets: typeof searchRecentTweetsEffect;
}

export interface LiveTransportGateway {
	bird: BirdReadTransport;
	xurl: XurlReadTransport;
}

// Every entry delegates to the Effect-native transport function directly;
// nothing round-trips through a Promise boundary. Spread forwarding keeps
// call arity identical to a direct call, which mocked transports assert on.
export const liveTransportGateway: LiveTransportGateway = {
	bird: {
		getAuthenticatedAccount: (...args) =>
			getAuthenticatedBirdAccountEffect(...args),
		listBookmarks: (...args) => listBookmarkedTweetsViaBirdEffect(...args),
		listDirectMessages: (...args) => listDirectMessagesViaBirdEffect(...args),
		listFollowUsers: (...args) => listFollowUsersViaBirdEffect(...args),
		listHomeTimeline: (...args) => listHomeTimelineViaBirdEffect(...args),
		listLikes: (...args) => listLikedTweetsViaBirdEffect(...args),
		listMentions: (...args) => listMentionsViaBirdEffect(...args),
		listThread: (...args) => listThreadViaBirdEffect(...args),
		searchTweets: (...args) => searchTweetsViaBirdEffect(...args),
	},
	xurl: {
		getTransportStatus: (...args) => getTransportStatusEffect(...args),
		getTweetById: (...args) => getTweetByIdEffect(...args),
		listBookmarks: (...args) => listBookmarkedTweetsViaXurlEffect(...args),
		listDirectMessages: (...args) =>
			listDirectMessageEventsViaXurlEffect(...args),
		listFollowUsers: (...args) => listFollowUsersViaXurlEffect(...args),
		listHomeTimeline: (...args) => listHomeTimelineViaXurlEffect(...args),
		listLikes: (...args) => listLikedTweetsViaXurlEffect(...args),
		listMentions: (...args) => listMentionsViaXurlEffect(...args),
		listUserTweets: (...args) => listUserTweetsEffect(...args),
		lookupAuthenticatedOAuth2User: (...args) =>
			lookupAuthenticatedOAuth2UserEffect(...args),
		lookupAuthenticatedUser: (...args) =>
			lookupAuthenticatedUserEffect(...args),
		lookupUsersByHandles: (...args) => lookupUsersByHandlesEffect(...args),
		searchConversation: (...args) =>
			searchRecentByConversationIdEffect(...args),
		searchRecentTweets: (...args) => searchRecentTweetsEffect(...args),
	},
};
