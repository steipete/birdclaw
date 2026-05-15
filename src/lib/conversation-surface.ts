import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { EmbeddedTweet } from "#/lib/types";

type ConversationStatus = "idle" | "loading" | "ready" | "error";

interface ConversationRecord {
	error: string | null;
	items: EmbeddedTweet[];
	status: ConversationStatus;
}

interface ConversationSurfaceSnapshot {
	expandedTweetId: string | null;
	records: ReadonlyMap<string, ConversationRecord>;
}

type Listener = () => void;

const emptyRecord: ConversationRecord = {
	error: null,
	items: [],
	status: "idle",
};

let snapshot: ConversationSurfaceSnapshot = {
	expandedTweetId: null,
	records: new Map(),
};
const listeners = new Set<Listener>();
const inFlight = new Set<string>();
let activeScopes = 0;
let generation = 0;

function emit() {
	for (const listener of listeners) {
		listener();
	}
}

function setSnapshot(next: ConversationSurfaceSnapshot) {
	snapshot = next;
	emit();
}

function updateRecord(tweetId: string, record: ConversationRecord) {
	const records = new Map(snapshot.records);
	records.set(tweetId, record);
	setSnapshot({ ...snapshot, records });
}

function subscribe(listener: Listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot() {
	return snapshot;
}

async function loadConversation(tweetId: string) {
	const current = snapshot.records.get(tweetId);
	if (current?.status === "ready" || inFlight.has(tweetId)) {
		return;
	}

	const loadGeneration = generation;
	inFlight.add(tweetId);
	updateRecord(tweetId, {
		error: null,
		items: current?.items ?? [],
		status: "loading",
	});

	try {
		const response = await fetch(
			`/api/conversation?tweetId=${encodeURIComponent(tweetId)}`,
		);
		const data = (await response.json()) as {
			error?: string;
			items?: EmbeddedTweet[];
			ok?: boolean;
		};
		if (!response.ok || data.ok === false) {
			throw new Error(data.error ?? "Conversation unavailable");
		}
		if (loadGeneration !== generation) {
			return;
		}
		updateRecord(tweetId, {
			error: null,
			items: (data.items ?? []).filter(Boolean),
			status: "ready",
		});
	} catch (error) {
		if (loadGeneration !== generation) {
			return;
		}
		updateRecord(tweetId, {
			error:
				error instanceof Error ? error.message : "Conversation unavailable",
			items: [],
			status: "error",
		});
	} finally {
		inFlight.delete(tweetId);
	}
}

export function retainConversationSurfaceScope() {
	activeScopes += 1;
	return () => {
		activeScopes = Math.max(0, activeScopes - 1);
		if (activeScopes === 0) {
			resetConversationSurface();
		}
	};
}

export function resetConversationSurface() {
	generation += 1;
	inFlight.clear();
	setSnapshot({
		expandedTweetId: null,
		records: new Map(),
	});
}

export function ConversationSurfaceScope({
	children,
}: {
	children: ReactNode;
}) {
	useEffect(() => retainConversationSurfaceScope(), []);
	return children;
}

export function useConversationSurface(tweetId: string) {
	const currentSnapshot = useSyncExternalStore(
		subscribe,
		getSnapshot,
		getSnapshot,
	);
	const record = currentSnapshot.records.get(tweetId) ?? emptyRecord;
	const isOpen = currentSnapshot.expandedTweetId === tweetId;

	const toggle = useCallback(() => {
		const nextExpanded = snapshot.expandedTweetId === tweetId ? null : tweetId;
		setSnapshot({ ...snapshot, expandedTweetId: nextExpanded });
		if (nextExpanded) {
			void loadConversation(tweetId);
		}
	}, [tweetId]);

	const prefetch = useCallback(() => {
		const current = snapshot.records.get(tweetId);
		if (current?.status === "ready" || current?.status === "loading") {
			return;
		}
		void loadConversation(tweetId);
	}, [tweetId]);

	return {
		error: record.error,
		isOpen,
		items: record.items,
		loading: record.status === "loading",
		prefetch,
		status: record.status,
		toggle,
	};
}
