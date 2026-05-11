import { createFileRoute } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InboxCard } from "#/components/InboxCard";
import type {
	InboxItem,
	InboxKind,
	InboxResponse,
	QueryEnvelope,
} from "#/lib/types";
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
});

const TABS: Array<{ value: InboxKind; label: string }> = [
	{ value: "mixed", label: "Mixed" },
	{ value: "mentions", label: "Mentions" },
	{ value: "dms", label: "DMs" },
];

function InboxRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<InboxItem[]>([]);
	const [kind, setKind] = useState<InboxKind>("mixed");
	const [minScore, setMinScore] = useState("40");
	const [hideLowSignal, setHideLowSignal] = useState(true);
	const [refreshTick, setRefreshTick] = useState(0);
	const [isScoring, setIsScoring] = useState(false);
	const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
	const [replyDraft, setReplyDraft] = useState("");
	const [isSendingReply, setIsSendingReply] = useState(false);
	const [stats, setStats] = useState<InboxResponse["stats"] | null>(null);

	useEffect(() => {
		fetch("/api/status")
			.then((response) => response.json())
			.then((data: QueryEnvelope) => setMeta(data));
	}, []);

	useEffect(() => {
		const url = new URL("/api/inbox", window.location.origin);
		url.searchParams.set("kind", kind);
		url.searchParams.set("minScore", minScore);
		url.searchParams.set("refresh", String(refreshTick));
		if (hideLowSignal) {
			url.searchParams.set("hideLowSignal", "1");
		}

		fetch(url)
			.then((response) => response.json())
			.then((data: InboxResponse) => {
				setItems(data.items);
				setStats(data.stats);
			});
	}, [hideLowSignal, kind, minScore, refreshTick]);

	const subtitle = useMemo(() => {
		if (!meta || !stats) return "Ranking unreplied mentions and DMs...";
		return `${String(stats.total)} in queue · ${String(stats.openai)} OpenAI scored · ${meta.transport.statusText}`;
	}, [meta, stats]);

	async function scoreNow() {
		setIsScoring(true);
		try {
			await fetch("/api/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: "scoreInbox",
					scoreKind: kind,
					limit: 8,
				}),
			});
			setRefreshTick((value) => value + 1);
		} finally {
			setIsScoring(false);
		}
	}

	async function sendReply(item: InboxItem) {
		if (!replyDraft.trim()) return;
		setIsSendingReply(true);
		try {
			await fetch("/api/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
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
				),
			});
			setReplyDraft("");
			setActiveReplyId(null);
			setRefreshTick((value) => value + 1);
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
						disabled={isScoring}
						onClick={() => void scoreNow()}
						type="button"
					>
						<Sparkles className="size-4" strokeWidth={2.2} />
						{isScoring ? "Scoring..." : "Score with OpenAI"}
					</button>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<input
						className={cx(textFieldClass, textFieldShortClass)}
						inputMode="numeric"
						onChange={(event) => setMinScore(event.target.value)}
						placeholder="Min AI score"
						value={minScore}
					/>
					<button
						className={secondaryButtonClass}
						onClick={() => setHideLowSignal((value) => !value)}
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
								onClick={() => setKind(tab.value)}
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
