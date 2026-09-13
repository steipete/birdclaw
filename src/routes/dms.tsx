import { useRouteSearchState } from "#/components/useRouteSearchState";
import { createFileRoute } from "@tanstack/react-router";
import {
	keepPreviousData,
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DmWorkspace } from "#/components/DmWorkspace";
import { FeedEmpty, FeedError, FeedLoading } from "#/components/FeedState";
import { SyncNowButton } from "#/components/SyncNowButton";
import { useQueryAccount } from "#/components/account-selection";
import { fetchJson, fetchQueryEnvelope, postAction } from "#/lib/api-client";
import { dmQueryResponseSchema, type QueryResponse } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import {
	type DmsRouteSearch,
	type RouteSearchChange,
	validateDmsSearch,
} from "#/lib/route-search";
import type {
	DmConversationItem,
	DmMessageItem,
	ReplyFilter,
} from "#/lib/types";
import { useDebouncedValue } from "#/components/useDebouncedValue";
import {
	cx,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	segmentActiveClass,
	segmentClass,
	segmentedClass,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
	timestampClass,
} from "#/lib/ui";

export const Route = createFileRoute("/dms")({
	component: DmsRoute,
	validateSearch: validateDmsSearch,
});

const TABS: Array<{ value: ReplyFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unreplied", label: "Unreplied" },
	{ value: "replied", label: "Replied" },
];

const SORTS: Array<{ value: "recent" | "followers"; label: string }> = [
	{ value: "recent", label: "Newest" },
	{ value: "followers", label: "Followers" },
];

type DmResponse = Extract<QueryResponse, { resource: "dms" }>;
type ThreadPages = InfiniteData<DmResponse, string | null>;
const DM_MESSAGE_PAGE_SIZE = 100;

type DmInboxFilter = "all" | "accepted" | "requests";

const INBOX_FILTERS: Array<{ value: DmInboxFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "accepted", label: "Accepted" },
	{ value: "requests", label: "Requests" },
];

const filterNumberFieldClass =
	"flex h-[46px] shrink-0 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--bg)] px-3 py-0 text-[14px] text-[var(--ink)] outline-none transition-colors duration-150 focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_1px_var(--accent)]";

function DmsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<DmsRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function DmsRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: DmsRouteSearch;
	onSearchChange?: RouteSearchChange<DmsRouteSearch>;
} = {}) {
	const queryClient = useQueryClient();
	const { searchState, updateSearch, textInput } = useRouteSearchState(
		controlledSearch,
		onSearchChange,
		validateDmsSearch,
	);
	const selectConversation = useCallback(
		(conversation: string) => updateSearch({ ...searchState, conversation }),
		[searchState, updateSearch],
	);
	const inboxFilter = searchState.inbox;
	const replyFilter = searchState.reply;
	const minFollowers = searchState.minFollowers;
	const minInfluenceScore = searchState.minInfluence;
	const sort = searchState.sort;
	const search = searchState.q;
	const selectedConversationId = searchState.conversation || undefined;
	const [replyDraft, setReplyDraft] = useState("");
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const meta = statusQuery.data ?? null;
	const { selectedAccountId, accountSelectionSettled } =
		useQueryAccount(statusQuery);
	const debouncedSearch = useDebouncedValue(search, 180);
	const dmsQueryKey = [
		...queryKeys.dms,
		{
			inboxFilter,
			replyFilter,
			minFollowers,
			minInfluenceScore,
			sort,
			search: debouncedSearch,
			selectedAccountId: selectedAccountId ?? null,
		},
	] as const;
	const dmsQuery = useQuery({
		queryKey: dmsQueryKey,
		enabled: accountSelectionSettled,
		queryFn: ({ signal }) => {
			const url = new URL("/api/query", window.location.origin);
			url.searchParams.set("resource", "dms");
			const cachedThread =
				selectedConversationId &&
				queryClient
					.getQueriesData<ThreadPages>({ queryKey: queryKeys.dmThreads })
					.some(([, data]) => {
						const thread = data?.pages[0]?.selectedConversation;
						return (
							thread?.conversation.id === selectedConversationId &&
							(inboxFilter === "requests" ||
								!selectedAccountId ||
								thread.conversation.accountId === selectedAccountId)
						);
					});
			if (cachedThread) url.searchParams.set("view", "list");
			else url.searchParams.set("messageLimit", String(DM_MESSAGE_PAGE_SIZE));
			if (!cachedThread && selectedConversationId)
				url.searchParams.set("conversationId", selectedConversationId);
			url.searchParams.set("inbox", inboxFilter);
			url.searchParams.set("replyFilter", replyFilter);
			url.searchParams.set("sort", sort);
			if (minFollowers.trim()) {
				url.searchParams.set("minFollowers", minFollowers.trim());
			}
			if (minInfluenceScore.trim()) {
				url.searchParams.set("minInfluenceScore", minInfluenceScore.trim());
			}
			if (selectedAccountId && inboxFilter !== "requests") {
				url.searchParams.set("account", selectedAccountId);
			}
			if (debouncedSearch.trim()) {
				url.searchParams.set("search", debouncedSearch.trim());
			}
			return fetchJson(
				url,
				{ signal },
				dmQueryResponseSchema,
				"Direct messages unavailable",
			);
		},
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
	const queryData = dmsQuery.data;
	const dmsData = queryData?.resource === "dms" ? queryData : null;
	const items: DmConversationItem[] = dmsData?.items ?? [];
	const selectedConversation =
		items.find((item) => item.id === selectedConversationId) ??
		items[0] ??
		null;
	const resolvedConversationId = selectedConversation?.id;
	const threadQueryKey = [
		...queryKeys.dmThreads,
		{
			account: selectedConversation?.accountId ?? null,
			conversationId: resolvedConversationId ?? null,
		},
	] as const;
	const threadQuery = useInfiniteQuery({
		queryKey: threadQueryKey,
		initialPageParam: null as string | null,
		getNextPageParam: (page) =>
			page.selectedConversation?.nextCursor ?? undefined,
		initialData: (): ThreadPages | undefined => {
			const thread = dmsData?.selectedConversation;
			return thread &&
				thread.conversation.id === resolvedConversationId &&
				thread.conversation.accountId === selectedConversation?.accountId
				? {
						pages: [
							{
								resource: "dms" as const,
								items: [],
								selectedConversation: thread,
							},
						],
						pageParams: [null],
					}
				: undefined;
		},
		initialDataUpdatedAt: dmsQuery.dataUpdatedAt,
		enabled:
			accountSelectionSettled &&
			!dmsQuery.isPlaceholderData &&
			Boolean(selectedConversation),
		queryFn: async ({ signal, pageParam }) => {
			const url = new URL("/api/query", window.location.origin);
			url.searchParams.set("resource", "dms");
			url.searchParams.set("view", "conversation");
			url.searchParams.set("messageLimit", String(DM_MESSAGE_PAGE_SIZE));
			if (pageParam) url.searchParams.set("before", pageParam);
			url.searchParams.set("conversationId", selectedConversation!.id);
			url.searchParams.set("account", selectedConversation!.accountId);
			const result = await fetchJson(
				url,
				{ signal },
				dmQueryResponseSchema,
				"Conversation unavailable",
			);
			if (!result.selectedConversation)
				throw new Error("Conversation unavailable");
			return result;
		},
		staleTime: 5 * 60_000,
	});
	const messages = useMemo(() => {
		const seen = new Set<string>();
		return [...(threadQuery.data?.pages ?? [])]
			.reverse()
			.flatMap((page) => page.selectedConversation?.messages ?? [])
			.filter((message) => {
				if (seen.has(message.id)) return false;
				seen.add(message.id);
				return true;
			});
	}, [threadQuery.data]);

	useEffect(() => {
		const thread = dmsData?.selectedConversation;
		if (
			dmsQuery.isPlaceholderData ||
			!thread ||
			thread.conversation.id !== resolvedConversationId ||
			thread.conversation.accountId !== selectedConversation?.accountId
		)
			return;
		if (
			(queryClient.getQueryState(threadQueryKey)?.dataUpdatedAt ?? 0) <
			dmsQuery.dataUpdatedAt
		) {
			queryClient.setQueryData<ThreadPages>(
				threadQueryKey,
				{
					pages: [{ resource: "dms", items: [], selectedConversation: thread }],
					pageParams: [null],
				},
				{ updatedAt: dmsQuery.dataUpdatedAt },
			);
		}
	}, [
		dmsData,
		dmsQuery.isPlaceholderData,
		dmsQuery.dataUpdatedAt,
		resolvedConversationId,
		selectedConversation?.accountId,
	]);

	useEffect(() => {
		if (!dmsQuery.data || dmsQuery.isPlaceholderData) return;
		if (
			resolvedConversationId &&
			resolvedConversationId !== selectedConversationId
		) {
			updateSearch(
				{ ...searchState, conversation: resolvedConversationId },
				{ replace: true },
			);
		}
	}, [
		dmsQuery.data,
		dmsQuery.isPlaceholderData,
		resolvedConversationId,
		selectedConversationId,
	]);
	const staleAccount = Boolean(
		inboxFilter !== "requests" &&
		selectedAccountId &&
		items.some((item) => item.accountId !== selectedAccountId),
	);
	const switchingConversation =
		staleAccount || Boolean(selectedConversation && threadQuery.isPending);

	const subtitle = useMemo(() => {
		if (!meta) return "Loading direct messages...";
		return `${String(meta.stats.dms)} conversations cached locally`;
	}, [meta]);
	const replyMutation = useMutation({
		mutationFn: ({
			conversationId,
			text,
		}: {
			conversationId: string;
			text: string;
		}) => postAction({ kind: "replyDm", conversationId, text }),
		onMutate: async ({ conversationId, text }) => {
			await Promise.all([
				queryClient.cancelQueries({ queryKey: dmsQueryKey }),
				queryClient.cancelQueries({ queryKey: threadQueryKey }),
			]);
			const previous = queryClient.getQueryData<QueryResponse>(dmsQueryKey);
			const previousThread =
				queryClient.getQueryData<ThreadPages>(threadQueryKey);
			if (!previous || previous.resource !== "dms" || !selectedConversation) {
				return {
					previous,
					previousThread,
					listKey: dmsQueryKey,
					threadKey: threadQueryKey,
				};
			}
			const now = new Date().toISOString();
			const accountRecord = meta?.accounts.find(
				(account) => account.id === selectedConversation.accountId,
			);
			const senderHandle = (
				accountRecord?.handle ?? selectedConversation.accountHandle
			).replace(/^@/, "");
			const optimisticMessage: DmMessageItem = {
				id: `optimistic-${now}`,
				conversationId,
				text,
				createdAt: now,
				direction: "outbound",
				isReplied: true,
				mediaCount: 0,
				sender: {
					id: `local-${selectedConversation.accountId}`,
					handle: senderHandle,
					displayName: accountRecord?.name ?? senderHandle,
					bio: "",
					followersCount: 0,
					avatarHue: 18,
					createdAt: now,
				},
			};
			queryClient.setQueryData<QueryResponse>(dmsQueryKey, {
				...previous,
				items: previous.items.map((item) =>
					item.id === conversationId
						? {
								...item,
								lastMessageAt: now,
								lastMessagePreview: text,
								needsReply: false,
								unreadCount: 0,
							}
						: item,
				),
			});
			if (previousThread?.pages[0]?.selectedConversation) {
				queryClient.setQueryData<ThreadPages>(threadQueryKey, {
					...previousThread,
					pages: previousThread.pages.map((page, index) =>
						index === 0 && page.selectedConversation
							? {
									...page,
									selectedConversation: {
										...page.selectedConversation,
										messages: [
											...page.selectedConversation.messages,
											optimisticMessage,
										],
									},
								}
							: page,
					),
				});
			}
			return {
				previous,
				previousThread,
				listKey: dmsQueryKey,
				threadKey: threadQueryKey,
			};
		},
		onError: (_error, _variables, context) => {
			if (context?.previous)
				queryClient.setQueryData(context.listKey, context.previous);
			if (context?.previousThread)
				queryClient.setQueryData(context.threadKey, context.previousThread);
		},
		onSettled: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: queryKeys.dms }),
				queryClient.invalidateQueries({ queryKey: queryKeys.dmThreads }),
				queryClient.invalidateQueries({ queryKey: queryKeys.status }),
			]),
	});

	async function replyToConversation(conversationId: string) {
		const text = replyDraft.trim();
		if (!text || !selectedConversation) return;
		setReplyDraft("");
		try {
			await replyMutation.mutateAsync({ conversationId, text });
			updateSearch({ ...searchState, conversation: conversationId });
		} catch {
			setReplyDraft(text);
		}
	}

	function refreshLocalView() {
		void Promise.all([
			queryClient.invalidateQueries({ queryKey: queryKeys.dms }),
			queryClient.invalidateQueries({ queryKey: queryKeys.dmThreads }),
			queryClient.invalidateQueries({ queryKey: queryKeys.status }),
		]);
	}
	const loading = dmsQuery.isPending;
	const queryError =
		dmsQuery.error ??
		(threadQuery.isFetchNextPageError ? null : threadQuery.error);
	const error = queryError
		? queryError instanceof Error
			? queryError.message
			: "Messages unavailable"
		: null;
	const replyError = replyMutation.error
		? replyMutation.error instanceof Error
			? replyMutation.error.message
			: "Reply failed"
		: null;

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Messages</h1>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
					<SyncNowButton
						accounts={meta?.accounts}
						kind="dms"
						label="Sync DMs"
						onSynced={refreshLocalView}
						syncOptions={{
							inbox: inboxFilter,
							limit: inboxFilter === "requests" ? 200 : 50,
							maxPages: inboxFilter === "requests" ? 3 : 1,
						}}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<div className={segmentedClass} aria-label="DM inbox">
						{INBOX_FILTERS.map((filter) => (
							<button
								key={filter.value}
								aria-pressed={inboxFilter === filter.value}
								className={cx(
									segmentClass,
									inboxFilter === filter.value && segmentActiveClass,
								)}
								onClick={() =>
									updateSearch({ ...searchState, inbox: filter.value })
								}
								type="button"
							>
								{filter.label}
							</button>
						))}
					</div>
					<label className={cx(searchFieldShellClass, "flex-1 min-w-[200px]")}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							{...textInput("q")}
							placeholder="Search DMs"
						/>
					</label>
					<label className={cx(filterNumberFieldClass, "w-[156px]")}>
						<span className="shrink-0 text-[12px] font-semibold text-[var(--ink-soft)]">
							Followers
						</span>
						<input
							className="min-w-0 flex-1 border-0 bg-transparent text-right text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]"
							inputMode="numeric"
							{...textInput("minFollowers")}
							placeholder="Any"
						/>
					</label>
					<label className={cx(filterNumberFieldClass, "w-[132px]")}>
						<span className="shrink-0 text-[12px] font-semibold text-[var(--ink-soft)]">
							Score
						</span>
						<input
							className="min-w-0 flex-1 border-0 bg-transparent text-right text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]"
							inputMode="numeric"
							{...textInput("minInfluence")}
							placeholder="Any"
						/>
					</label>
					<div className={segmentedClass}>
						{SORTS.map((option) => (
							<button
								key={option.value}
								className={cx(
									segmentClass,
									option.value === sort && segmentActiveClass,
								)}
								onClick={() =>
									updateSearch({ ...searchState, sort: option.value })
								}
								type="button"
							>
								{option.label}
							</button>
						))}
					</div>
				</div>
				<div className={tabStripClass} aria-label="DM reply filter">
					{TABS.map((tab) => {
						const active = replyFilter === tab.value;
						return (
							<button
								key={tab.value}
								type="button"
								aria-pressed={active}
								className={cx(tabButtonClass, active && tabButtonActiveClass)}
								onClick={() =>
									updateSearch({ ...searchState, reply: tab.value })
								}
							>
								<span className="relative inline-flex flex-col items-center justify-center py-1">
									{tab.value}
									{active ? <span className={tabButtonIndicatorClass} /> : null}
								</span>
							</button>
						);
					})}
				</div>
			</header>
			{replyError ? (
				<p className={cx(timestampClass, "px-4 py-2 text-red-500")}>
					{replyError}
				</p>
			) : null}

			{(loading && items.length === 0) || switchingConversation ? (
				<FeedLoading
					detail="Reading local conversations and reply state"
					label="Loading messages"
				/>
			) : error ? (
				<FeedError
					action={
						<button
							className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white"
							onClick={() =>
								void Promise.all([
									dmsQuery.refetch(),
									...(selectedConversation ? [threadQuery.refetch()] : []),
								])
							}
							type="button"
						>
							Retry
						</button>
					}
					message={error}
					title="Could not load messages"
				/>
			) : items.length === 0 ? (
				<FeedEmpty
					detail="Sync DMs or broaden the filters to find a conversation."
					label="No conversations in this view"
				/>
			) : (
				<DmWorkspace
					conversations={items}
					onReplyDraftChange={setReplyDraft}
					onReplySend={replyToConversation}
					onSelectConversation={selectConversation}
					replyDraft={replyDraft}
					selectedConversation={selectedConversation}
					selectedMessages={messages}
					hasEarlier={threadQuery.hasNextPage}
					loadingEarlier={threadQuery.isFetchingNextPage}
					onLoadEarlier={() => void threadQuery.fetchNextPage()}
					earlierError={
						threadQuery.isFetchNextPageError
							? "Could not load earlier messages. Try again."
							: undefined
					}
				/>
			)}
		</>
	);
}
