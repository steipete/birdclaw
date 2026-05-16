import { createFileRoute } from "@tanstack/react-router";
import {
	CalendarDays,
	CheckCircle2,
	Loader2,
	MessageSquare,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PeriodDigestRunResult,
	PeriodDigestStreamEvent,
} from "#/lib/period-digest";
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
	statusCopyClass,
} from "#/lib/ui";

export const Route = createFileRoute("/today")({
	component: TodayRoute,
});

type PeriodOption = "today" | "24h" | "yesterday" | "week";

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
	if (refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function formatCounts(result: PeriodDigestRunResult | null) {
	if (!result) return "Local Twitter memory, summarized as it streams.";
	const counts = result.context.counts;
	return [
		`${String(counts.home)} home`,
		`${String(counts.mentions)} mentions`,
		`${String(counts.links)} links`,
		result.context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function useDigestStream(period: PeriodOption, includeDms: boolean) {
	const [markdown, setMarkdown] = useState("");
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef(0);

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
			setResult(null);
			setError(null);
			setLoading(true);

			fetch(digestUrl(period, includeDms, refresh), {
				signal: controller.signal,
			})
				.then((response) => {
					if (!response.ok || !response.body) {
						throw new Error(
							`Digest request failed: ${String(response.status)}`,
						);
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
									const event = JSON.parse(line) as PeriodDigestStreamEvent;
									if (!isActiveRequest()) return;
									if (event.type === "delta") {
										setMarkdown((current) => current + event.delta);
									} else if (event.type === "done") {
										setResult(event.result);
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
					setError(cause instanceof Error ? cause.message : "Digest failed");
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

	return { error, loading, markdown, result, run };
}

function TodayRoute() {
	const [period, setPeriod] = useState<PeriodOption>("today");
	const [includeDms, setIncludeDms] = useState(false);
	const { error, loading, markdown, result, run } = useDigestStream(
		period,
		includeDms,
	);
	const actionCount = result?.digest.actionItems.length ?? 0;
	const sourceLabel = useMemo(() => formatCounts(result), [result]);

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

			{error ? <div className={errorCopyClass}>{error}</div> : null}

			<section className="flex flex-col gap-4 border-b border-[var(--line)] px-4 py-4">
				<div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--ink-soft)]">
					<span className="inline-flex items-center gap-1">
						{loading ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : (
							<CheckCircle2 className="size-4" aria-hidden="true" />
						)}
						{loading ? "Streaming GPT-5.5 medium" : "Ready"}
					</span>
					{result ? (
						<>
							<span>· {result.model}</span>
							<span>· {result.cached ? "cached" : result.serviceTier}</span>
							<span>· {result.context.window.label}</span>
						</>
					) : null}
				</div>

				{result && actionCount > 0 ? (
					<div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-2">
						<div className="mb-2 flex items-center gap-2 text-[13px] font-bold">
							<MessageSquare className="size-4" aria-hidden="true" />
							Action items
						</div>
						<ul className="flex flex-col gap-1 text-[14px] text-[var(--ink)]">
							{result.digest.actionItems.map((item, index) => (
								<li key={`${item.kind}:${item.label}:${String(index)}`}>
									<span className="font-semibold capitalize">{item.kind}</span>:{" "}
									{item.label}
								</li>
							))}
						</ul>
					</div>
				) : null}
			</section>

			{markdown ? (
				<article className="prose prose-sm max-w-none whitespace-pre-wrap break-words px-4 py-4 text-[15px] leading-6 text-[var(--ink)] prose-headings:text-[var(--ink)] prose-a:text-[var(--accent)]">
					{markdown}
				</article>
			) : (
				<div className={statusCopyClass}>
					<span className="inline-flex items-center gap-2">
						{loading ? (
							<Sparkles className="size-4 animate-pulse" aria-hidden="true" />
						) : (
							<CalendarDays className="size-4" aria-hidden="true" />
						)}
						{loading ? "Waiting for the first tokens..." : "No digest yet."}
					</span>
				</div>
			)}
		</div>
	);
}
