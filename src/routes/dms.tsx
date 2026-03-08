import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DmWorkspace } from "#/components/DmWorkspace";
import type {
	DmConversationItem,
	DmMessageItem,
	QueryEnvelope,
	QueryResponse,
	ReplyFilter,
} from "#/lib/types";

export const Route = createFileRoute("/dms")({
	component: DmsRoute,
});

function DmsRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [items, setItems] = useState<DmConversationItem[]>([]);
	const [messages, setMessages] = useState<DmMessageItem[]>([]);
	const [selectedConversationId, setSelectedConversationId] = useState<
		string | undefined
	>();
	const [replyFilter, setReplyFilter] = useState<ReplyFilter>("unreplied");
	const [minFollowers, setMinFollowers] = useState("0");
	const [minInfluenceScore, setMinInfluenceScore] = useState("0");
	const [sort, setSort] = useState<"recent" | "influence">("recent");
	const [search, setSearch] = useState("");
	const [replyDraft, setReplyDraft] = useState("");
	const [refreshTick, setRefreshTick] = useState(0);

	useEffect(() => {
		fetch("/api/status")
			.then((response) => response.json())
			.then((data: QueryEnvelope) => setMeta(data));
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const url = new URL("/api/query", window.location.origin);
		url.searchParams.set("resource", "dms");
		url.searchParams.set("replyFilter", replyFilter);
		url.searchParams.set("minFollowers", minFollowers);
		url.searchParams.set("minInfluenceScore", minInfluenceScore);
		url.searchParams.set("refresh", String(refreshTick));
		url.searchParams.set("sort", sort);
		if (selectedConversationId) {
			url.searchParams.set("conversationId", selectedConversationId);
		}
		if (search.trim()) {
			url.searchParams.set("search", search.trim());
		}

		fetch(url, { signal: controller.signal })
			.then((response) => response.json())
			.then((data: QueryResponse) => {
				const conversations = data.items as DmConversationItem[];
				const nextSelected =
					data.selectedConversation?.conversation.id ?? conversations[0]?.id;
				setItems(conversations);
				setSelectedConversationId((current) => {
					if (!current) return nextSelected;
					return conversations.some(
						(conversation) => conversation.id === current,
					)
						? current
						: nextSelected;
				});
				setMessages(data.selectedConversation?.messages ?? []);
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
				throw error;
			});

		return () => {
			controller.abort();
		};
	}, [
		minFollowers,
		minInfluenceScore,
		refreshTick,
		replyFilter,
		search,
		selectedConversationId,
		sort,
	]);

	const selectedConversation =
		items.find((item) => item.id === selectedConversationId) ?? null;

	const subtitle = useMemo(() => {
		if (!meta) return "Loading direct messages...";
		return `${meta.stats.dms} conversations cached locally · filter by follower load or derived influence score`;
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
			await fetch("/api/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: "replyDm",
					conversationId,
					text,
				}),
			});

			setSelectedConversationId(conversationId);
			setRefreshTick((value) => value + 1);
		} catch (error) {
			setReplyDraft(text);
			setMessages(previousMessages);
			setItems(previousItems);
			throw error;
		}
	}

	return (
		<main className="page-wrap">
			<section className="hero-shell hero-shell-dm">
				<div>
					<p className="eyebrow">direct messages</p>
					<h2 className="hero-title">
						Influence, bio, and reply state. No hunting.
					</h2>
					<p className="hero-copy">{subtitle}</p>
				</div>
				<div className="hero-controls hero-controls-dm">
					<input
						className="text-field"
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search DMs"
						value={search}
					/>
					<input
						className="text-field text-field-short"
						inputMode="numeric"
						onChange={(event) => setMinFollowers(event.target.value)}
						placeholder="Min followers"
						value={minFollowers}
					/>
					<input
						className="text-field text-field-short"
						inputMode="numeric"
						onChange={(event) => setMinInfluenceScore(event.target.value)}
						placeholder="Min score"
						value={minInfluenceScore}
					/>
					<div className="segmented">
						{(["recent", "influence"] as const).map((value) => (
							<button
								key={value}
								className={
									value === sort ? "segment segment-active" : "segment"
								}
								onClick={() => setSort(value)}
								type="button"
							>
								{value}
							</button>
						))}
					</div>
					<div className="segmented">
						{(["all", "replied", "unreplied"] as const).map((value) => (
							<button
								key={value}
								className={
									value === replyFilter ? "segment segment-active" : "segment"
								}
								onClick={() => setReplyFilter(value)}
								type="button"
							>
								{value}
							</button>
						))}
					</div>
				</div>
			</section>

			<DmWorkspace
				conversations={items}
				onReplyDraftChange={setReplyDraft}
				onReplySend={replyToConversation}
				onSelectConversation={setSelectedConversationId}
				replyDraft={replyDraft}
				selectedConversation={selectedConversation}
				selectedMessages={messages}
			/>
		</main>
	);
}
