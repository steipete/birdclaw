import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
	Activity,
	AlertTriangle,
	Clock3,
	Gauge,
	RefreshCw,
	ShieldCheck,
} from "lucide-react";
import { useMemo } from "react";
import { xurlRateLimitSnapshotSchema } from "#/lib/api-contracts";
import { fetchJson } from "#/lib/api-client";
import { formatNumber } from "#/lib/present";
import { queryKeys } from "#/lib/query-client";
import type {
	XurlRateLimitEndpointSnapshot,
	XurlRateLimitEvent,
} from "#/lib/xurl-rate-limits";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	statusCopyClass,
} from "#/lib/ui";

export const Route = createFileRoute("/rate-limits")({
	component: RateLimitsRoute,
});

async function fetchRateLimits() {
	return fetchJson(
		"/api/xurl-rate-limits",
		undefined,
		xurlRateLimitSnapshotSchema,
		"Rate limits request failed",
	);
}

function formatAge(value: string | null, nowMs: number) {
	if (!value) return "never";
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return "unknown";
	const seconds = Math.max(0, Math.round((nowMs - time) / 1000));
	if (seconds < 60) return `${String(seconds)}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${String(minutes)}m ago`;
	const hours = Math.round(minutes / 60);
	return `${String(hours)}h ago`;
}

function formatReset(value: string | null, nowMs: number) {
	if (!value) return "idle";
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return "unknown";
	const seconds = Math.max(0, Math.round((time - nowMs) / 1000));
	if (seconds < 60) return `${String(seconds)}s`;
	return `${String(Math.round(seconds / 60))}m`;
}

function statusTone(status: XurlRateLimitEndpointSnapshot["status"]) {
	if (status === "critical") {
		return "border-[color:color-mix(in_srgb,var(--alert)_55%,var(--line))] bg-[var(--alert-soft)] text-[var(--alert)]";
	}
	if (status === "warning") {
		return "border-[color:color-mix(in_srgb,#f59e0b_55%,var(--line))] bg-[color:color-mix(in_srgb,#f59e0b_13%,var(--bg))] text-[color:color-mix(in_srgb,#f59e0b_85%,var(--ink))]";
	}
	if (status === "quiet") {
		return "border-[var(--line)] bg-[var(--bg-active)] text-[var(--ink-soft)]";
	}
	return "border-[color:color-mix(in_srgb,#22c55e_45%,var(--line))] bg-[color:color-mix(in_srgb,#22c55e_12%,var(--bg))] text-[color:color-mix(in_srgb,#22c55e_80%,var(--ink))]";
}

function statusIcon(status: XurlRateLimitEndpointSnapshot["status"]) {
	if (status === "critical") return AlertTriangle;
	if (status === "warning") return Clock3;
	if (status === "quiet") return Gauge;
	return ShieldCheck;
}

function SummaryTile({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof Activity;
	label: string;
	value: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2 border-b border-[var(--line)] px-4 py-3 sm:border-r">
			<div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)]">
				<Icon className="size-4" strokeWidth={1.8} />
				<span>{label}</span>
			</div>
			<div className="truncate text-[24px] font-bold tracking-tight text-[var(--ink)]">
				{value}
			</div>
		</div>
	);
}

function EndpointRow({
	endpoint,
	nowMs,
}: {
	endpoint: XurlRateLimitEndpointSnapshot;
	nowMs: number;
}) {
	const Icon = statusIcon(endpoint.status);
	return (
		<div className="grid gap-3 border-b border-[var(--line)] px-4 py-4 min-[760px]:grid-cols-[minmax(0,1.25fr)_minmax(180px,0.75fr)_92px]">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span
						className={cx(
							"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-bold capitalize",
							statusTone(endpoint.status),
						)}
					>
						<Icon className="size-3.5" strokeWidth={1.9} />
						{endpoint.status}
					</span>
					<span className="font-bold text-[var(--ink)]">{endpoint.label}</span>
				</div>
				<div className="mt-1 font-mono text-[12px] text-[var(--ink-soft)]">
					{endpoint.method} {endpoint.path}
				</div>
				<div className="mt-1 text-[13px] text-[var(--ink-soft)]">
					{endpoint.description}
				</div>
			</div>
			<div className="min-w-0">
				<div className="mb-2 flex items-center justify-between gap-3 text-[13px] text-[var(--ink-soft)]">
					<span>{formatNumber(endpoint.callsLastWindow)} calls</span>
					<span>{formatNumber(endpoint.estimatedRemaining)} est. left</span>
				</div>
				<div className="h-2 overflow-hidden rounded-full bg-[var(--bg-active)]">
					<div
						className="h-full rounded-full bg-[var(--accent)]"
						style={{ width: `${String(endpoint.usagePercent)}%` }}
					/>
				</div>
				<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--ink-soft)]">
					<span>{formatNumber(endpoint.perUserLimit)}/user</span>
					<span>{formatNumber(endpoint.perAppLimit)}/app</span>
					<span>{String(endpoint.rateLimitedLastWindow)} 429s</span>
					<span>{String(endpoint.errorsLastWindow)} errors</span>
				</div>
			</div>
			<div className="flex min-[760px]:flex-col gap-2 text-[12px] text-[var(--ink-soft)]">
				<span>last {formatAge(endpoint.lastEventAt, nowMs)}</span>
				<span>reset {formatReset(endpoint.estimatedResetAt, nowMs)}</span>
			</div>
		</div>
	);
}

function EventRow({
	event,
	nowMs,
}: {
	event: XurlRateLimitEvent;
	nowMs: number;
}) {
	return (
		<div className="grid gap-2 border-b border-[var(--line)] px-4 py-3 text-[13px] min-[760px]:grid-cols-[120px_minmax(0,1fr)_120px]">
			<div className="font-bold capitalize text-[var(--ink)]">
				{event.status.replace("_", " ")}
			</div>
			<div className="min-w-0">
				<div className="truncate font-mono text-[12px] text-[var(--ink-soft)]">
					{event.endpoint}
				</div>
				<div className="truncate text-[var(--ink-soft)]">
					{event.source}
					{event.handle ? ` · @${event.handle}` : ""}
				</div>
				{event.detail ? (
					<div className="mt-1 line-clamp-2 break-words text-[var(--ink-soft)]">
						{event.detail}
					</div>
				) : null}
			</div>
			<div className="text-[var(--ink-soft)]">{formatAge(event.at, nowMs)}</div>
		</div>
	);
}

function RateLimitsRoute() {
	const rateLimitsQuery = useQuery({
		queryKey: queryKeys.rateLimits,
		queryFn: fetchRateLimits,
		staleTime: 60_000,
	});
	const snapshot = rateLimitsQuery.data ?? null;
	const loading = rateLimitsQuery.isFetching;
	const error = rateLimitsQuery.error;
	const nowMs = useMemo(() => Date.now(), [snapshot]);

	return (
		<section className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Rate Limits</h1>
						<p className={pageSubtitleClass}>
							Observed xurl calls with X API 15-minute windows.
						</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<a
							className={secondaryButtonClass}
							href={
								snapshot?.docsUrl ??
								"https://docs.x.com/x-api/fundamentals/rate-limits"
							}
							rel="noreferrer"
							target="_blank"
						>
							<Gauge className="size-4" strokeWidth={1.8} />
							Docs
						</a>
						<button
							className={secondaryButtonClass}
							disabled={loading}
							onClick={() => void rateLimitsQuery.refetch()}
							type="button"
						>
							<RefreshCw
								className={cx("size-4", loading && "animate-spin")}
								strokeWidth={1.8}
							/>
							Refresh
						</button>
					</div>
				</div>
			</header>

			{error ? (
				<div className={errorCopyClass}>
					{error instanceof Error ? error.message : "Rate limits failed"}
				</div>
			) : null}

			{snapshot ? (
				<>
					<div className="grid border-b border-[var(--line)] sm:grid-cols-2 min-[1040px]:grid-cols-4">
						<SummaryTile
							icon={Activity}
							label="Calls in window"
							value={formatNumber(snapshot.summary.totalCallsLastWindow)}
						/>
						<SummaryTile
							icon={AlertTriangle}
							label="429s in window"
							value={formatNumber(snapshot.summary.rateLimitedLastWindow)}
						/>
						<SummaryTile
							icon={Clock3}
							label="Retry policy"
							value={`${String(snapshot.throttle.rateLimitMaxRetries)} x ${String(Math.round(snapshot.throttle.rateLimitRetryMs / 1000))}s`}
						/>
						<SummaryTile
							icon={Gauge}
							label="Conversation delay"
							value={`${String(snapshot.throttle.conversationDelayMs)}ms`}
						/>
					</div>

					<div className="border-b border-[var(--line)]">
						{snapshot.endpoints.map((endpoint) => (
							<EndpointRow
								endpoint={endpoint}
								key={endpoint.key}
								nowMs={nowMs}
							/>
						))}
					</div>

					<div className="px-4 py-3 text-[13px] font-bold text-[var(--ink)]">
						Recent xurl events
					</div>
					{snapshot.events.length > 0 ? (
						<div>
							{snapshot.events.slice(0, 30).map((event) => (
								<EventRow event={event} key={event.id} nowMs={nowMs} />
							))}
						</div>
					) : (
						<p className={statusCopyClass}>No observed xurl calls yet.</p>
					)}
				</>
			) : loading ? (
				<p className={statusCopyClass}>Loading rate limits...</p>
			) : null}
		</section>
	);
}
