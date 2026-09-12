import { createFileRoute } from "@tanstack/react-router";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
	const [localSearch, setLocalSearch] = useState(() => validateDmsSearch({}));
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<DmsRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
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
			selectedConversationId: selectedConversationId ?? null,
		},
	] as const;
	const dmsQuery = useQuery({
		queryKey: dmsQueryKey,
		enabled: accountSelectionSettled,
		queryFn: ({ signal }) => {
			const url = new URL("/api/query", window.location.origin);
			url.searchParams.set("resource", "dms");
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
			if (selectedConversationId) {
				url.searchParams.set("conversationId", selectedConversationId);
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
	const messages = dmsData?.selectedConversation?.messages ?? [];
	const loadedConversationId = dmsData?.selectedConversation?.conversation.id;

	useEffect(() => {
		if (!dmsQuery.data) return;
		const nextSelected = loadedConversationId ?? items[0]?.id;
		const resolved =
			selectedConversationId &&
			items.some((conversation) => conversation.id === selectedConversationId)
				? selectedConversationId
				: nextSelected;
		if (resolved && resolved !== selectedConversationId) {
			updateSearch(
				{ ...searchState, conversation: resolved },
				{ replace: true },
			);
		}
	}, [dmsQuery.data, items, loadedConversationId]);

	const selectedConversation =
		items.find((item) => item.id === selectedConversationId) ?? null;
	const switchingConversation = Boolean(
		!dmsQuery.isError &&
		selectedConversationId &&
		loadedConversationId &&
		selectedConversationId !== loadedConversationId,
	);

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
			await queryClient.cancelQueries({ queryKey: dmsQueryKey });
			const previous = queryClient.getQueryData<QueryResponse>(dmsQueryKey);
			if (!previous || previous.resource !== "dms" || !selectedConversation) {
				return { previous };
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
				selectedConversation: previous.selectedConversation
					? {
							...previous.selectedConversation,
							messages: [
								...previous.selectedConversation.messages,
								optimisticMessage,
							],
						}
					: previous.selectedConversation,
			});
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(dmsQueryKey, context.previous);
			}
		},
		onSettled: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: queryKeys.dms }),
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
			queryClient.invalidateQueries({ queryKey: queryKeys.status }),
		]);
	}
	const loading = dmsQuery.isPending;
	const error = dmsQuery.error
		? dmsQuery.error instanceof Error
			? dmsQuery.error.message
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
							onChange={(event) =>
								updateSearch(
									{ ...searchState, q: event.target.value },
									{ replace: true },
								)
							}
							placeholder="Search DMs"
							value={search}
						/>
					</label>
					<label className={cx(filterNumberFieldClass, "w-[156px]")}>
						<span className="shrink-0 text-[12px] font-semibold text-[var(--ink-soft)]">
							Followers
						</span>
						<input
							className="min-w-0 flex-1 border-0 bg-transparent text-right text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]"
							inputMode="numeric"
							onChange={(event) =>
								updateSearch(
									{
										...searchState,
										minFollowers: event.target.value,
									},
									{ replace: true },
								)
							}
							placeholder="Any"
							value={minFollowers}
						/>
					</label>
					<label className={cx(filterNumberFieldClass, "w-[132px]")}>
						<span className="shrink-0 text-[12px] font-semibold text-[var(--ink-soft)]">
							Score
						</span>
						<input
							className="min-w-0 flex-1 border-0 bg-transparent text-right text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]"
							inputMode="numeric"
							onChange={(event) =>
								updateSearch(
									{
										...searchState,
										minInfluence: event.target.value,
									},
									{ replace: true },
								)
							}
							placeholder="Any"
							value={minInfluenceScore}
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
							onClick={() => void dmsQuery.refetch()}
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
					onSelectConversation={(conversation) =>
						updateSearch({ ...searchState, conversation })
					}
					replyDraft={replyDraft}
					selectedConversation={selectedConversation}
					selectedMessages={messages}
				/>
			)}
		</>
	);
}
