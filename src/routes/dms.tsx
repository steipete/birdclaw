import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DmWorkspace } from "#/components/DmWorkspace";
import { FeedEmpty, FeedError, FeedLoading } from "#/components/FeedState";
import { SyncNowButton } from "#/components/SyncNowButton";
import { useSelectedAccountId } from "#/components/account-selection";
import {
	fetchCachedQueryResponse,
	fetchQueryEnvelope,
	invalidateCachedQueryResponses,
	postAction,
	readCachedQueryResponse,
} from "#/lib/api-client";
import type {
	DmConversationItem,
	DmMessageItem,
	QueryEnvelope,
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
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<DmConversationItem[]>([]);
	const [messages, setMessages] = useState<DmMessageItem[]>([]);
	const [loadedConversationId, setLoadedConversationId] = useState<
		string | undefined
	>();
	const [selectedConversationId, setSelectedConversationId] = useState<
		string | undefined
	>();
	const [inboxFilter, setInboxFilter] = useState<DmInboxFilter>("all");
	const [replyFilter, setReplyFilter] = useState<ReplyFilter>("unreplied");
	const [minFollowers, setMinFollowers] = useState("");
	const [minInfluenceScore, setMinInfluenceScore] = useState("");
	const [sort, setSort] = useState<"recent" | "followers">("recent");
	const [search, setSearch] = useState("");
	const [replyDraft, setReplyDraft] = useState("");
	const [refreshTick, setRefreshTick] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [replyError, setReplyError] = useState<string | null>(null);
	const selectedAccountId = useSelectedAccountId(meta?.accounts);
	const debouncedSearch = useDebouncedValue(search, 180);

	async function loadStatus(force = false) {
		setMeta(await fetchQueryEnvelope(undefined, { force }));
	}

	useEffect(() => {
		void loadStatus();
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let active = true;
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", "dms");
		url.searchParams.set("inbox", inboxFilter);
		url.searchParams.set("replyFilter", replyFilter);
		url.searchParams.set("refresh", String(refreshTick));
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

		const applyResponse = (
			data: Awaited<ReturnType<typeof fetchCachedQueryResponse>>,
		) => {
			const conversations = data.items as DmConversationItem[];
			const nextSelected =
				data.selectedConversation?.conversation.id ?? conversations[0]?.id;
			setLoadedConversationId(data.selectedConversation?.conversation.id);
			setItems(conversations);
			setSelectedConversationId((current) => {
				if (!current) return nextSelected;
				return conversations.some((conversation) => conversation.id === current)
					? current
					: nextSelected;
			});
			setMessages(data.selectedConversation?.messages ?? []);
		};
		setError(null);
		const cached = readCachedQueryResponse(url);
		if (cached) {
			applyResponse(cached);
			setLoading(false);
			return () => {
				active = false;
				controller.abort();
			};
		}
		setLoading(true);
		fetchCachedQueryResponse(url, { signal: controller.signal })
			.then((data) => {
				if (!active) return;
				applyResponse(data);
			})
			.catch((fetchError: unknown) => {
				if (
					fetchError instanceof DOMException &&
					fetchError.name === "AbortError"
				) {
					return;
				}
				if (!active) return;
				setError(
					fetchError instanceof Error
						? fetchError.message
						: "Messages unavailable",
				);
				setItems([]);
				setMessages([]);
				setLoadedConversationId(undefined);
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});

		return () => {
			active = false;
			controller.abort();
		};
	}, [
		minFollowers,
		minInfluenceScore,
		inboxFilter,
		refreshTick,
		replyFilter,
		debouncedSearch,
		selectedConversationId,
		selectedAccountId,
		sort,
	]);

	const selectedConversation =
		items.find((item) => item.id === selectedConversationId) ?? null;
	const switchingConversation =
		loading &&
		Boolean(
			selectedConversationId &&
			loadedConversationId &&
			selectedConversationId !== loadedConversationId,
		);

	const subtitle = useMemo(() => {
		if (!meta) return "Loading direct messages...";
		return `${String(meta.stats.dms)} conversations cached locally`;
	}, [meta]);

	async function replyToConversation(conversationId: string) {
		const text = replyDraft.trim();
		if (!text || !selectedConversation) return;

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
		const previousMessages = messages;
		const previousItems = items;

		setReplyError(null);
		setReplyDraft("");
		setMessages((current) => [...current, optimisticMessage]);
		setItems((current) =>
			current.map((item) =>
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
		);

		try {
			await postAction({
				kind: "replyDm",
				conversationId,
				text,
			});

			invalidateCachedQueryResponses();
			setSelectedConversationId(conversationId);
			setRefreshTick((value) => value + 1);
		} catch (error) {
			setReplyDraft(text);
			setMessages(previousMessages);
			setItems(previousItems);
			setReplyError(error instanceof Error ? error.message : "Reply failed");
		}
	}

	function refreshLocalView() {
		invalidateCachedQueryResponses();
		setRefreshTick((value) => value + 1);
		void loadStatus(true);
	}

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
								onClick={() => setInboxFilter(filter.value)}
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
							onChange={(event) => setSearch(event.target.value)}
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
							onChange={(event) => setMinFollowers(event.target.value)}
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
							onChange={(event) => setMinInfluenceScore(event.target.value)}
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
								onClick={() => setSort(option.value)}
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
								onClick={() => setReplyFilter(tab.value)}
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

			{loading && (items.length === 0 || switchingConversation) ? (
				<FeedLoading
					detail="Reading local conversations and reply state"
					label="Loading messages"
				/>
			) : error ? (
				<FeedError
					action={
						<button
							className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white"
							onClick={() => setRefreshTick((value) => value + 1)}
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
					onSelectConversation={setSelectedConversationId}
					replyDraft={replyDraft}
					selectedConversation={selectedConversation}
					selectedMessages={messages}
				/>
			)}
		</>
	);
}
