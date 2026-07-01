import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	FileDown,
	Loader2,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { useNdjsonRun } from "#/components/useNdjsonRun";
import {
	isTerminalStreamEvent,
	periodDigestStreamEventSchema,
} from "#/lib/client-stream-contracts";
import type {
	PeriodDigestContext,
	PeriodDigestRunResult,
	PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import type { ProfileRecord } from "#/lib/types";
import {
	hydrateProfileHandles,
	normalizeProfileHydrationHandle as normalizeHandle,
} from "#/lib/profile-hydration-client";
import {
	type PeriodRouteSearch,
	type RouteSearchChange,
	type TodayRouteSearch,
	validateTodaySearch,
} from "#/lib/route-search";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentAccentActiveClass,
	segmentClass,
	segmentedClass,
} from "#/lib/ui";

export const Route = createFileRoute("/today")({
	component: TodayRoute,
	validateSearch: validateTodaySearch,
});

type PeriodOption = PeriodRouteSearch;
const PROFILE_HYDRATION_LIMIT = 12;
const PROFILE_HYDRATION_DELAY_MS = 300;
const DIGEST_STATUS_MESSAGES = {
	524: "Digest startup timed out at Cloudflare (524). Retry to open a new stream.",
} as const;

const periods: Array<{ value: PeriodOption; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
];

function periodLabel(period: PeriodOption) {
	return periods.find((item) => item.value === period)?.label ?? "Digest";
}

function exportCurrentDigestPdf(title: string) {
	const previousTitle = document.title;
	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		document.title = previousTitle;
		window.removeEventListener("afterprint", cleanup);
	};

	document.title = title;
	window.addEventListener("afterprint", cleanup, { once: true });
	window.setTimeout(cleanup, 3000);
	window.print();
}

function digestUrl(
	period: PeriodOption,
	includeDms: boolean,
	refresh: boolean,
) {
	const url = new URL("/api/period-digest", window.location.origin);
	url.searchParams.set("period", period);
	url.searchParams.set("includeDms", String(includeDms));
	url.searchParams.set("maxTweets", "5000");
	url.searchParams.set("maxLinks", "20");
	// Cloudflare caps proxied requests; live timeline sync remains a separate job/UI action.
	url.searchParams.set("liveSync", "false");
	if (refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function digestStreamError(cause: unknown, phase: string) {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (
		cause instanceof TypeError &&
		/network error|failed to fetch|load failed/i.test(message)
	) {
		return `Digest connection was interrupted while ${phase.toLowerCase()}. Retry to continue.`;
	}
	if (cause instanceof SyntaxError) {
		return `Digest stream returned invalid data while ${phase.toLowerCase()}. Retry to continue.`;
	}
	return message || "Digest failed";
}

function formatCounts(context: PeriodDigestContext | null) {
	if (!context) return "Local Twitter memory, summarized as it streams.";
	const counts = context.counts;
	return [
		`${String(counts.home)} home`,
		`${String(counts.mentions)} mentions`,
		`${String(counts.links)} links`,
		context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function collectProfilesForHydration(result: PeriodDigestRunResult) {
	const handles = new Set<string>();
	const tweetIds = new Set<string>();
	for (const id of result.digest.sourceTweetIds) tweetIds.add(id);
	for (const topic of result.digest.keyTopics) {
		for (const id of topic.tweetIds) tweetIds.add(id);
	}
	for (const link of result.digest.notableLinks) {
		for (const id of link.sourceTweetIds) tweetIds.add(id);
	}
	for (const item of result.digest.actionItems) {
		if (item.tweetId) tweetIds.add(item.tweetId);
	}

	const tweetsById = new Map(
		result.context.tweets.flatMap((tweet) => [
			[tweet.id, tweet],
			[`tweet_${tweet.id}`, tweet],
		]),
	);
	for (const id of tweetIds) {
		const tweet = tweetsById.get(id);
		if (!tweet) continue;
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
	}

	for (const tweet of result.context.tweets) {
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
	}
	return [...handles];
}

function applyHydratedProfilesToContext(
	context: PeriodDigestContext,
	profilesByHandle: Map<string, ProfileRecord>,
) {
	let changed = false;
	const tweets = context.tweets.map((tweet) => {
		const profile = profilesByHandle.get(normalizeHandle(tweet.author));
		if (!profile || profile === tweet.authorProfile) return tweet;
		changed = true;
		return {
			...tweet,
			author: profile.handle,
			name: profile.displayName,
			authorProfile: profile,
		};
	});
	return changed ? { ...context, tweets } : context;
}

function applyHydratedProfilesToResult(
	result: PeriodDigestRunResult,
	profiles: ProfileRecord[],
) {
	const profilesByHandle = new Map(
		profiles.map((profile) => [normalizeHandle(profile.handle), profile]),
	);
	if (profilesByHandle.size === 0) return result;
	const context = applyHydratedProfilesToContext(
		result.context,
		profilesByHandle,
	);
	return context === result.context ? result : { ...result, context };
}

function useDigestStream(period: PeriodOption, includeDms: boolean) {
	const queryClient = useQueryClient();
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<PeriodDigestContext | null>(null);
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [status, setStatus] = useState("Starting digest");
	const latestStatusRef = useRef("Starting digest");

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
		setStatus("Starting digest");
		latestStatusRef.current = "Starting digest";
	}, []);
	const request = useCallback(
		(signal: AbortSignal, refresh: boolean) =>
			fetch(digestUrl(period, includeDms, refresh), {
				cache: "no-store",
				signal,
			}),
		[includeDms, period],
	);
	const onEvent = useCallback((event: PeriodDigestStreamEvent) => {
		if (event.type === "status") {
			latestStatusRef.current = event.detail
				? `${event.label} · ${event.detail}`
				: event.label;
			setStatus(latestStatusRef.current);
		} else if (event.type === "start") setContext(event.context);
		else if (event.type === "delta") {
			latestStatusRef.current = "Streaming AI summary";
			setStatus(latestStatusRef.current);
			setMarkdown((current) => current + event.delta);
		} else if (event.type === "done") {
			setResult(event.result);
			setContext(event.result.context);
			setMarkdown(event.result.markdown);
			setStatus(event.result.cached ? "Loaded cached report" : "Ready");
		} else if (event.type === "error") {
			throw new Error(event.error);
		}
	}, []);
	const onError = useCallback(() => setStatus("Digest failed"), []);
	const prematureEofError = useCallback(
		() =>
			new Error(
				`Digest connection closed while ${latestStatusRef.current.toLowerCase()}. Retry to continue.`,
			),
		[],
	);
	const formatError = useCallback(
		(cause: unknown) => digestStreamError(cause, latestStatusRef.current),
		[],
	);
	const { error, loading, run } = useNdjsonRun({
		schema: periodDigestStreamEventSchema,
		request,
		onStart,
		onEvent,
		onError,
		isTerminal: isTerminalStreamEvent,
		errorLabel: "Digest request failed",
		emptyBodyMessage: "Digest request failed: empty response body",
		prematureEofError,
		formatError,
		statusMessages: DIGEST_STATUS_MESSAGES,
	});

	useEffect(() => {
		run(false);
	}, [run]);

	useEffect(() => {
		if (!result) return;
		const handles = collectProfilesForHydration(result);
		if (handles.length === 0) return;

		let active = true;
		let idleId: number | null = null;
		const runHydration = () => {
			hydrateProfileHandles(queryClient, handles, {
				limit: PROFILE_HYDRATION_LIMIT,
			})
				.then((response) => {
					if (!active) return;
					const { profiles } = response;
					if (profiles.length === 0) return;
					setResult((current) =>
						current
							? applyHydratedProfilesToResult(current, profiles)
							: current,
					);
					const profilesByHandle = new Map(
						profiles.map((profile) => [
							normalizeHandle(profile.handle),
							profile,
						]),
					);
					setContext((current) =>
						current
							? applyHydratedProfilesToContext(current, profilesByHandle)
							: current,
					);
				})
				.catch((error: unknown) => {
					if (!active) return;
					console.warn("Profile hydration failed", error);
				});
		};
		const timer = window.setTimeout(() => {
			if ("requestIdleCallback" in window) {
				idleId = window.requestIdleCallback(runHydration, { timeout: 2500 });
			} else {
				runHydration();
			}
		}, PROFILE_HYDRATION_DELAY_MS);

		return () => {
			active = false;
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [queryClient, result]);

	return { context, error, loading, markdown, result, run, status };
}

function TodayRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<TodayRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function TodayRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: TodayRouteSearch;
	onSearchChange?: RouteSearchChange<TodayRouteSearch>;
} = {}) {
	const [localSearch, setLocalSearch] = useState(() => validateTodaySearch({}));
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<TodayRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
	const { period, includeDms } = searchState;
	const { context, error, loading, markdown, result, run, status } =
		useDigestStream(period, includeDms);
	useEffect(() => {
		const root = document.documentElement;
		root.classList.add("today-pdf-route");
		return () => root.classList.remove("today-pdf-route");
	}, []);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);
	const digestLabel =
		result?.context.window.label ??
		context?.window.label ??
		periodLabel(period);
	const canExportPdf = Boolean(result?.markdown.trim()) && !loading;
	const exportTitle = `BirdClaw ${digestLabel} digest`;
	const exportUpdatedAt = result
		? new Date(result.updatedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
	const handleExportPdf = useCallback(() => {
		if (!canExportPdf) return;
		exportCurrentDigestPdf(exportTitle);
	}, [canExportPdf, exportTitle]);

	return (
		<div className="today-pdf-root flex min-h-screen flex-col">
			<header className={cx("today-pdf-header", pageHeaderClass)}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>What happened</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={cx("today-screen-only", pageHeaderActionsClass)}>
						{canExportPdf ? (
							<button
								type="button"
								className={secondaryButtonClass}
								onClick={handleExportPdf}
							>
								<FileDown className="size-4" aria-hidden="true" />
								Export PDF
							</button>
						) : null}
						<button
							type="button"
							className={secondaryButtonClass}
							onClick={() => run(true)}
							disabled={loading}
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								aria-hidden="true"
							/>
							Refresh
						</button>
					</div>
				</div>
				<div className="today-pdf-meta" aria-hidden="true">
					<span>{digestLabel}</span>
					<span>·</span>
					<span>Sources: {sourceLabel}</span>
					{exportUpdatedAt ? (
						<>
							<span>·</span>
							<span>Generated {exportUpdatedAt}</span>
						</>
					) : null}
				</div>
				<div className="today-screen-only flex flex-wrap items-center gap-2 px-4 pb-3">
					<div className={segmentedClass} aria-label="Digest period">
						{periods.map((item) => (
							<button
								key={item.value}
								type="button"
								aria-pressed={period === item.value}
								className={cx(
									segmentClass,
									period === item.value && segmentAccentActiveClass,
								)}
								onClick={() =>
									updateSearch({ ...searchState, period: item.value })
								}
							>
								{item.label}
							</button>
						))}
					</div>
					<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)]">
						<input
							type="checkbox"
							checked={includeDms}
							onChange={(event) =>
								updateSearch({
									...searchState,
									includeDms: event.currentTarget.checked,
								})
							}
						/>
						DMs
					</label>
				</div>
			</header>

			{error ? (
				<div
					className={cx(
						errorCopyClass,
						"flex items-center justify-between gap-3",
					)}
					role="alert"
				>
					<span>{error}</span>
					<button
						className="shrink-0 font-semibold underline underline-offset-2"
						onClick={() => run(true)}
						type="button"
					>
						Retry
					</button>
				</div>
			) : null}

			<div className="today-screen-only border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
				<span className="inline-flex items-center gap-1">
					{loading ? (
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					) : markdown ? (
						<CheckCircle2 className="size-4" aria-hidden="true" />
					) : (
						<Sparkles className="size-4" aria-hidden="true" />
					)}
					{loading
						? status
						: result
							? `${result.cached ? "Cached" : "Ready"} · ${result.context.window.label}`
							: error
								? "Digest failed"
								: "Ready"}
				</span>
			</div>

			{markdown ? (
				<MarkdownViewer
					context={result?.context ?? context}
					markdown={markdown}
				/>
			) : (
				<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
					{loading
						? status
						: error
							? "No digest was generated. Retry to start a new run."
							: "Waiting for the first tokens..."}
				</div>
			)}
		</div>
	);
}
