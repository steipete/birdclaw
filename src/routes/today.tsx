import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import type {
	PeriodDigestContext,
	PeriodDigestRunResult,
	PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import type { ProfileRecord } from "#/lib/types";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentActiveClass,
	segmentClass,
	segmentedClass,
} from "#/lib/ui";

export const Route = createFileRoute("/today")({
	component: TodayRoute,
});

type PeriodOption = "today" | "24h" | "yesterday" | "week";
type HydrateProfileResult = {
	handle: string;
	status: "hit" | "miss" | "error";
	profile?: ProfileRecord;
};

const PROFILE_HYDRATION_LIMIT = 12;
const PROFILE_HYDRATION_DELAY_MS = 300;

const periods: Array<{ value: PeriodOption; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
];

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

async function digestRequestError(response: Response) {
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
	if (response.status === 524) {
		return new Error(
			"Digest startup timed out at Cloudflare (524). Retry to open a new stream.",
		);
	}
	return new Error(
		detail
			? `Digest request failed (${status}): ${detail}`
			: `Digest request failed (${status})`,
	);
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

function normalizeHandle(value: string) {
	return value.trim().replace(/^@/, "").toLowerCase();
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
		if (handles.size >= PROFILE_HYDRATION_LIMIT) return [...handles];
	}

	for (const tweet of result.context.tweets) {
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
		if (handles.size >= PROFILE_HYDRATION_LIMIT) return [...handles];
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
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<PeriodDigestContext | null>(null);
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState("Starting digest");
	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef(0);
	const hydratedHandlesRef = useRef(new Set<string>());
	const hydratedProfilesRef = useRef(new Map<string, ProfileRecord>());

	const run = useCallback(
		(refresh = false) => {
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
			setStatus("Starting digest");
			setLoading(true);
			let latestStatus = "Starting digest";
			let completed = false;

			fetch(digestUrl(period, includeDms, refresh), {
				cache: "no-store",
				signal: controller.signal,
			})
				.then(async (response) => {
					if (!response.ok) {
						throw await digestRequestError(response);
					}
					if (!response.body) {
						throw new Error("Digest request failed: empty response body");
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					const pump = (): Promise<void> =>
						reader.read().then(({ done, value }) => {
							if (!isActiveRequest()) return;
							if (done) {
								if (!completed) {
									throw new Error(
										`Digest connection closed while ${latestStatus.toLowerCase()}. Retry to continue.`,
									);
								}
								return;
							}
							buffer += decoder.decode(value, { stream: true });
							let newline = buffer.indexOf("\n");
							while (newline >= 0) {
								const line = buffer.slice(0, newline).trim();
								buffer = buffer.slice(newline + 1);
								if (line) {
									const event = JSON.parse(line) as PeriodDigestStreamEvent;
									if (!isActiveRequest()) return;
									if (event.type === "status") {
										latestStatus = event.detail
											? `${event.label} · ${event.detail}`
											: event.label;
										setStatus(latestStatus);
									} else if (event.type === "start") {
										setContext(event.context);
									} else if (event.type === "delta") {
										latestStatus = "Streaming AI summary";
										setStatus(latestStatus);
										setMarkdown((current) => current + event.delta);
									} else if (event.type === "done") {
										completed = true;
										setResult(event.result);
										setContext(event.result.context);
										setMarkdown(event.result.markdown);
										setStatus(
											event.result.cached ? "Loaded cached report" : "Ready",
										);
									} else if (event.type === "error") {
										completed = true;
										setError(event.error);
										setStatus("Digest failed");
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
					setError(digestStreamError(cause, latestStatus));
					setStatus("Digest failed");
				})
				.finally(() => {
					if (isActiveRequest()) {
						setLoading(false);
					}
				});
		},
		[includeDms, period],
	);

	useEffect(() => {
		run(false);
		return () => abortRef.current?.abort();
	}, [run]);

	useEffect(() => {
		if (!result) return;
		if (hydratedProfilesRef.current.size > 0) {
			const cachedProfiles = [...hydratedProfilesRef.current.values()];
			setResult((current) =>
				current
					? applyHydratedProfilesToResult(current, cachedProfiles)
					: current,
			);
			setContext((current) =>
				current
					? applyHydratedProfilesToContext(current, hydratedProfilesRef.current)
					: current,
			);
		}
		const handles = collectProfilesForHydration(result).filter(
			(handle) => !hydratedHandlesRef.current.has(handle),
		);
		if (handles.length === 0) return;

		const controller = new AbortController();
		const url = new URL("/api/profile-hydrate", window.location.origin);
		url.searchParams.set("handles", handles.join(","));

		let idleId: number | null = null;
		const runHydration = () => {
			fetch(url, { signal: controller.signal })
				.then((response) => response.json())
				.then((response: { results?: HydrateProfileResult[] }) => {
					for (const handle of handles) hydratedHandlesRef.current.add(handle);
					const profiles =
						response.results
							?.map((item) => item.profile)
							.filter((profile): profile is ProfileRecord =>
								Boolean(profile),
							) ?? [];
					if (profiles.length === 0) return;
					for (const profile of profiles) {
						hydratedProfilesRef.current.set(
							normalizeHandle(profile.handle),
							profile,
						);
					}
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
					if (error instanceof DOMException && error.name === "AbortError") {
						return;
					}
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
			controller.abort();
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [result]);

	return { context, error, loading, markdown, result, run, status };
}

function TodayRoute() {
	const [period, setPeriod] = useState<PeriodOption>("today");
	const [includeDms, setIncludeDms] = useState(false);
	const { context, error, loading, markdown, result, run, status } =
		useDigestStream(period, includeDms);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);

	return (
		<div className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>What happened</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={pageHeaderActionsClass}>
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
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<div className={segmentedClass} aria-label="Digest period">
						{periods.map((item) => (
							<button
								key={item.value}
								type="button"
								className={cx(
									segmentClass,
									period === item.value && segmentActiveClass,
								)}
								onClick={() => setPeriod(item.value)}
							>
								{item.label}
							</button>
						))}
					</div>
					<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)]">
						<input
							type="checkbox"
							checked={includeDms}
							onChange={(event) => setIncludeDms(event.currentTarget.checked)}
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
