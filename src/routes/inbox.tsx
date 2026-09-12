import { createFileRoute } from "@tanstack/react-router";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryAccount } from "#/components/account-selection";
import { InboxCard } from "#/components/InboxCard";
import { inboxResponseSchema } from "#/lib/api-contracts";
import { fetchJson, fetchQueryEnvelope, postAction } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import { useDeploymentMode } from "#/lib/deployment-mode";
import {
	type InboxRouteSearch,
	type RouteSearchChange,
	validateInboxSearch,
} from "#/lib/route-search";
import type { InboxItem, InboxKind } from "#/lib/types";
import {
	cx,
	emptyStateClass,
	feedClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	secondaryButtonClass,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
	textFieldClass,
	textFieldShortClass,
	timestampClass,
} from "#/lib/ui";

export const Route = createFileRoute("/inbox")({
	component: InboxRoute,
	validateSearch: validateInboxSearch,
});

const TABS: Array<{ value: InboxKind; label: string }> = [
	{ value: "mixed", label: "Mixed" },
	{ value: "mentions", label: "Mentions" },
	{ value: "dms", label: "DMs" },
];

function InboxRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<InboxRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function InboxRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: InboxRouteSearch;
	onSearchChange?: RouteSearchChange<InboxRouteSearch>;
} = {}) {
	const queryClient = useQueryClient();
	const { readOnly } = useDeploymentMode();
	const [localSearch, setLocalSearch] = useState(() => validateInboxSearch({}));
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<InboxRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
	const { kind, minScore, hideLowSignal } = searchState;
	const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
	const [replyDraft, setReplyDraft] = useState("");
	const [isSendingReply, setIsSendingReply] = useState(false);
	const [replyError, setReplyError] = useState<string | null>(null);
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const meta = statusQuery.data ?? null;
	const { selectedAccountId, accountSelectionSettled } =
		useQueryAccount(statusQuery);
	const inboxQueryKey = [
		...queryKeys.inbox,
		{
			hideLowSignal,
			kind,
			minScore,
			selectedAccountId: selectedAccountId ?? null,
		},
	] as const;
	const inboxQuery = useQuery({
		queryKey: inboxQueryKey,
		enabled: accountSelectionSettled,
		queryFn: async ({ signal }) => {
			const url = new URL("/api/inbox", window.location.origin);
			url.searchParams.set("kind", kind);
			url.searchParams.set("minScore", minScore);
			if (selectedAccountId) {
				url.searchParams.set("account", selectedAccountId);
			}
			if (hideLowSignal) {
				url.searchParams.set("hideLowSignal", "1");
			}

			return fetchJson(
				url,
				{ signal },
				inboxResponseSchema,
				"Inbox request failed",
			);
		},
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
	const items = inboxQuery.data?.items ?? [];
	const stats = inboxQuery.data?.stats ?? null;
	const scoreMutation = useMutation({
		mutationFn: () =>
			postAction({
				kind: "scoreInbox",
				scoreKind: kind,
				account: selectedAccountId,
				limit: 8,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.inbox }),
	});

	const subtitle = useMemo(() => {
		if (!meta || !stats) return "Ranking unreplied mentions and DMs...";
		return `${String(stats.total)} in queue · ${String(stats.openai)} OpenAI scored · ${meta.transport.statusText}`;
	}, [meta, stats]);

	async function scoreNow() {
		await scoreMutation.mutateAsync();
	}

	async function sendReply(item: InboxItem) {
		if (!replyDraft.trim()) return;
		setIsSendingReply(true);
		setReplyError(null);
		try {
			await postAction(
				item.entityKind === "dm"
					? {
							kind: "replyDm",
							conversationId: item.entityId,
							text: replyDraft,
						}
					: {
							kind: "replyTweet",
							accountId: item.accountId,
							tweetId: item.entityId,
							text: replyDraft,
						},
			);
			setReplyDraft("");
			setActiveReplyId(null);
			await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
		} catch (error) {
			setReplyError(error instanceof Error ? error.message : "Reply failed");
		} finally {
			setIsSendingReply(false);
		}
	}

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Inbox</h1>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
					<button
						className={primaryButtonClass}
						disabled={scoreMutation.isPending}
						hidden={readOnly}
						onClick={() => void scoreNow()}
						type="button"
					>
						<Sparkles className="size-4" strokeWidth={2.2} />
						{scoreMutation.isPending ? "Scoring..." : "Score with OpenAI"}
					</button>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<input
						className={cx(textFieldClass, textFieldShortClass)}
						inputMode="numeric"
						onChange={(event) =>
							updateSearch(
								{ ...searchState, minScore: event.target.value },
								{ replace: true },
							)
						}
						placeholder="Min AI score"
						value={minScore}
					/>
					<button
						className={secondaryButtonClass}
						onClick={() =>
							updateSearch({
								...searchState,
								hideLowSignal: !hideLowSignal,
							})
						}
						type="button"
						aria-pressed={hideLowSignal}
					>
						{hideLowSignal ? "Hide low-signal" : "Show all"}
					</button>
				</div>
				<div className={tabStripClass}>
					{TABS.map((tab) => {
						const active = kind === tab.value;
						return (
							<button
								key={tab.value}
								type="button"
								aria-pressed={active}
								className={cx(tabButtonClass, active && tabButtonActiveClass)}
								onClick={() =>
									updateSearch({ ...searchState, kind: tab.value })
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
			<section className={feedClass}>
				{items.length === 0 ? (
					<div className={emptyStateClass}>Inbox clear.</div>
				) : null}
				{items.map((item) => (
					<InboxCard
						key={item.id}
						isReplying={activeReplyId === item.id}
						item={item}
						onReplyChange={setReplyDraft}
						onReplySend={() => void sendReply(item)}
						onReplyToggle={() => {
							setReplyError(null);
							if (activeReplyId === item.id) {
								setActiveReplyId(null);
								setReplyDraft("");
								return;
							}
							setActiveReplyId(item.id);
							setReplyDraft("");
						}}
						replyDraft={activeReplyId === item.id ? replyDraft : ""}
					/>
				))}
			</section>
			{isSendingReply ? (
				<p className={cx(timestampClass, "px-4 py-2")}>Sending reply...</p>
			) : null}
		</>
	);
}
