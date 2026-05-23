import { createFileRoute } from "@tanstack/react-router";
import {
	CheckCircle2,
	Loader2,
	RefreshCw,
	Search,
	Sparkles,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import type {
	SearchDiscussionContext,
	SearchDiscussionRunResult,
	SearchDiscussionSource,
	SearchDiscussionStreamEvent,
} from "#/lib/search-discussion";
import type { TweetSearchMode } from "#/lib/tweet-search-live";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
	selectFieldClass,
	textFieldClass,
} from "#/lib/ui";

export const Route = createFileRoute("/discuss")({
	component: DiscussRoute,
});

const sources: Array<{ value: SearchDiscussionSource; label: string }> = [
	{ value: "search", label: "Live search" },
	{ value: "all", label: "All local" },
	{ value: "home", label: "Home" },
	{ value: "mentions", label: "Mentions" },
	{ value: "authored", label: "Authored" },
	{ value: "likes", label: "Likes" },
	{ value: "bookmarks", label: "Bookmarks" },
];

const modes: Array<{ value: TweetSearchMode; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "bird", label: "Bird" },
	{ value: "xurl", label: "xurl" },
	{ value: "local", label: "Local" },
];

function discussionUrl(
	query: string,
	options: {
		source: SearchDiscussionSource;
		mode: TweetSearchMode;
		includeDms: boolean;
		question: string;
		refresh: boolean;
	},
) {
	const url = new URL("/api/search-discussion", window.location.origin);
	url.searchParams.set("query", query);
	url.searchParams.set("source", options.source);
	url.searchParams.set("mode", options.mode);
	url.searchParams.set("includeDms", String(options.includeDms));
	url.searchParams.set("limit", "500");
	url.searchParams.set("maxPages", "5");
	if (options.question.trim()) {
		url.searchParams.set("question", options.question.trim());
	}
	if (options.refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

async function discussionRequestError(response: Response) {
	const status = `${String(response.status)}${response.statusText ? ` ${response.statusText}` : ""}`;
	let detail = "";
	try {
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			const payload = (await response.json()) as {
				error?: unknown;
				message?: unknown;
			};
			if (typeof payload.message === "string") detail = payload.message;
			else if (typeof payload.error === "string") detail = payload.error;
		} else {
			detail = (await response.text()).trim();
		}
	} catch {
		detail = "";
	}
	return new Error(
		detail
			? `Discussion request failed (${status}): ${detail}`
			: `Discussion request failed (${status})`,
	);
}

function formatCounts(context: SearchDiscussionContext | null) {
	if (!context) return "Live keyword search with local memory.";
	const counts = context.counts;
	const live = context.liveSearch
		? context.liveSearch.ok
			? `${context.liveSearch.source} ${String(context.liveSearch.count)} fetched`
			: `${context.liveSearch.source} failed`
		: "local";
	return [
		live,
		`${String(counts.search)} search`,
		`${String(counts.home + counts.mentions + counts.authored)} timeline`,
		`${String(counts.likes + counts.bookmarks)} saved`,
		context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function useDiscussionStream(
	query: string,
	source: SearchDiscussionSource,
	mode: TweetSearchMode,
	includeDms: boolean,
	question: string,
) {
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<SearchDiscussionContext | null>(null);
	const [result, setResult] = useState<SearchDiscussionRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef(0);

	const run = useCallback(
		(refresh = false) => {
			const trimmed = query.trim();
			if (!trimmed) return;
			abortRef.current?.abort();
			const controller = new AbortController();
			const requestId = requestIdRef.current + 1;
			requestIdRef.current = requestId;
			abortRef.current = controller;
			const isActiveRequest = () =>
				abortRef.current === controller &&
				requestIdRef.current === requestId &&
				!controller.signal.aborted;
			setMarkdown("");
			setContext(null);
			setResult(null);
			setError(null);
			setLoading(true);

			fetch(
				discussionUrl(trimmed, {
					source,
					mode,
					includeDms,
					question,
					refresh,
				}),
				{ signal: controller.signal },
			)
				.then(async (response) => {
					if (!response.ok) {
						throw await discussionRequestError(response);
					}
					if (!response.body) {
						throw new Error("Discussion request failed: empty response body");
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					const pump = (): Promise<void> =>
						reader.read().then(({ done, value }) => {
							if (!isActiveRequest()) return;
							if (done) return;
							buffer += decoder.decode(value, { stream: true });
							let newline = buffer.indexOf("\n");
							while (newline >= 0) {
								const line = buffer.slice(0, newline).trim();
								buffer = buffer.slice(newline + 1);
								if (line) {
									const event = JSON.parse(line) as SearchDiscussionStreamEvent;
									if (!isActiveRequest()) return;
									if (event.type === "start") {
										setContext(event.context);
									} else if (event.type === "delta") {
										setMarkdown((current) => current + event.delta);
									} else if (event.type === "done") {
										setResult(event.result);
										setContext(event.result.context);
										setMarkdown(event.result.markdown);
									} else if (event.type === "error") {
										setError(event.error);
									}
								}
								newline = buffer.indexOf("\n");
							}
							return pump();
						});
					return pump();
				})
				.catch((cause: unknown) => {
					if (!isActiveRequest()) return;
					setError(
						cause instanceof Error ? cause.message : "Discussion failed",
					);
				})
				.finally(() => {
					if (isActiveRequest()) {
						setLoading(false);
					}
				});
		},
		[includeDms, mode, query, question, source],
	);

	useEffect(() => () => abortRef.current?.abort(), []);

	return { context, error, loading, markdown, result, run };
}

function DiscussRoute() {
	const [query, setQuery] = useState("");
	const [submittedQuery, setSubmittedQuery] = useState("");
	const [question, setQuestion] = useState("");
	const [source, setSource] = useState<SearchDiscussionSource>("search");
	const [mode, setMode] = useState<TweetSearchMode>("auto");
	const [includeDms, setIncludeDms] = useState(false);
	const pendingSubmitRef = useRef(false);
	const { context, error, loading, markdown, result, run } =
		useDiscussionStream(submittedQuery, source, mode, includeDms, question);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);

	function submit(event: FormEvent) {
		event.preventDefault();
		const trimmed = query.trim();
		if (!trimmed) return;
		pendingSubmitRef.current = true;
		setSubmittedQuery(trimmed);
		if (trimmed === submittedQuery) {
			pendingSubmitRef.current = false;
			run(true);
		}
	}

	useEffect(() => {
		if (!submittedQuery || !pendingSubmitRef.current) return;
		pendingSubmitRef.current = false;
		run(true);
	}, [run, submittedQuery]);

	return (
		<div className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>Discuss</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading || !submittedQuery}
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
						</button>
					</div>
				</div>
				<form
					className="grid gap-2 px-4 pb-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_auto]"
					onSubmit={submit}
				>
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							placeholder="Keywords"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
						/>
					</label>
					<input
						className={textFieldClass}
						placeholder="Question"
						value={question}
						onChange={(event) => setQuestion(event.currentTarget.value)}
					/>
					<button
						type="submit"
						className={primaryButtonClass}
						disabled={loading || !query.trim()}
					>
						<Sparkles className="size-4" aria-hidden="true" />
						Discuss
					</button>
					<div className="flex flex-wrap gap-2 md:col-span-3">
						<select
							className={selectFieldClass}
							value={source}
							onChange={(event) =>
								setSource(event.currentTarget.value as SearchDiscussionSource)
							}
						>
							{sources.map((item) => (
								<option key={item.value} value={item.value}>
									{item.label}
								</option>
							))}
						</select>
						<select
							className={selectFieldClass}
							value={mode}
							onChange={(event) =>
								setMode(event.currentTarget.value as TweetSearchMode)
							}
						>
							{modes.map((item) => (
								<option key={item.value} value={item.value}>
									{item.label}
								</option>
							))}
						</select>
						<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)]">
							<input
								type="checkbox"
								checked={includeDms}
								onChange={(event) => setIncludeDms(event.currentTarget.checked)}
							/>
							DMs
						</label>
					</div>
				</form>
			</header>

			{error ? <div className={errorCopyClass}>{error}</div> : null}

			<div className="border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
				<span className="inline-flex items-center gap-1">
					{loading ? (
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					) : markdown ? (
						<CheckCircle2 className="size-4" aria-hidden="true" />
					) : (
						<Sparkles className="size-4" aria-hidden="true" />
					)}
					{loading
						? "Searching and streaming"
						: result
							? `${result.cached ? "Cached" : "Ready"} · ${result.context.query}`
							: "Ready"}
				</span>
			</div>

			{markdown ? (
				<MarkdownViewer
					context={(result?.context ?? context) as never}
					markdown={markdown}
				/>
			) : (
				<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
					{loading ? "Waiting for the first tokens..." : "Search to begin."}
				</div>
			)}
		</div>
	);
}
