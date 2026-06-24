import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
	AlertTriangle,
	CheckCircle2,
	Database,
	RefreshCw,
	Route as RouteIcon,
	TerminalSquare,
	XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { liveDataSourcesResponseSchema } from "#/lib/api-contracts";
import { fetchJson, fetchQueryEnvelope } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type {
	LiveDataSourceCapability,
	LiveDataSourceKind,
	LiveDataSourceStatus,
} from "#/lib/types";
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
import { useSelectedAccountId } from "#/components/account-selection";

export const Route = createFileRoute("/data-sources")({
	component: DataSourcesRoute,
});

async function fetchDataSources(accountId: string | undefined) {
	const path = accountId
		? `/api/data-sources?account=${encodeURIComponent(accountId)}`
		: "/api/data-sources";
	return fetchJson(
		path,
		undefined,
		liveDataSourcesResponseSchema,
		"Data source status failed",
	);
}

function sourceIcon(source: LiveDataSourceKind) {
	if (source === "birdclaw") return Database;
	if (source === "bird") return TerminalSquare;
	return RouteIcon;
}

function statusTone(status: LiveDataSourceStatus["status"]) {
	if (status === "ok") {
		return "border-[color:color-mix(in_srgb,#22c55e_45%,var(--line))] bg-[color:color-mix(in_srgb,#22c55e_10%,var(--bg))] text-[color:color-mix(in_srgb,#22c55e_82%,var(--ink))]";
	}
	if (status === "warning") {
		return "border-[color:color-mix(in_srgb,#f59e0b_50%,var(--line))] bg-[color:color-mix(in_srgb,#f59e0b_12%,var(--bg))] text-[color:color-mix(in_srgb,#f59e0b_82%,var(--ink))]";
	}
	return "border-[color:color-mix(in_srgb,var(--alert)_55%,var(--line))] bg-[var(--alert-soft)] text-[var(--alert)]";
}

function statusIcon(status: LiveDataSourceStatus["status"]) {
	if (status === "ok") return CheckCircle2;
	if (status === "warning") return AlertTriangle;
	return XCircle;
}

function sourceLabel(source: LiveDataSourceKind) {
	if (source === "birdclaw") return "local";
	return source;
}

function SourceCard({ source }: { source: LiveDataSourceStatus }) {
	const Icon = sourceIcon(source.source);
	const StatusIcon = statusIcon(source.status);
	return (
		<section className="min-w-0 border-b border-[var(--line)] px-4 py-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<div className="grid size-10 shrink-0 place-items-center rounded-md border border-[var(--line)] bg-[var(--bg-active)] text-[var(--ink)]">
						<Icon className="size-5" strokeWidth={1.9} />
					</div>
					<div className="min-w-0">
						<h2 className="truncate text-[16px] font-bold text-[var(--ink)]">
							{source.label}
						</h2>
						<p className="truncate text-[13px] text-[var(--ink-soft)]">
							{source.installed === false ? "not installed" : source.detail}
						</p>
					</div>
				</div>
				<span
					className={cx(
						"inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-bold",
						statusTone(source.status),
					)}
				>
					<StatusIcon className="size-3.5" strokeWidth={2} />
					{source.works ? "works" : source.status}
				</span>
			</div>
			<div className="mt-4 flex flex-wrap gap-2">
				{source.accounts.length > 0 ? (
					source.accounts.map((account, index) => (
						<span
							key={`${account.app ?? ""}:${account.username ?? account.handle ?? account.id ?? String(index)}`}
							className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-2.5 py-1 text-[12px] font-semibold text-[var(--ink-soft)]"
						>
							{account.app ? (
								<span className="text-[var(--ink-faint)]">{account.app}</span>
							) : null}
							<span className="truncate">
								{account.handle ??
									(account.username ? `@${account.username}` : account.id)}
							</span>
							{account.isDefault ? (
								<span className="text-[var(--accent)]">default</span>
							) : null}
						</span>
					))
				) : (
					<span className="text-[13px] text-[var(--ink-soft)]">
						no authenticated account detected
					</span>
				)}
			</div>
		</section>
	);
}

function CapabilityRow({
	capability,
	sourcesByKind,
}: {
	capability: LiveDataSourceCapability;
	sourcesByKind: Map<LiveDataSourceKind, LiveDataSourceStatus>;
}) {
	const chain = [capability.primary, ...capability.fallbacks];
	return (
		<div className="grid gap-3 border-b border-[var(--line)] px-4 py-4 min-[840px]:grid-cols-[220px_minmax(0,1fr)]">
			<div className="min-w-0">
				<div className="font-bold text-[var(--ink)]">{capability.label}</div>
				{capability.notes ? (
					<div className="mt-1 text-[12px] text-[var(--ink-soft)]">
						{capability.notes}
					</div>
				) : null}
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				{chain.map((source, index) => {
					const status = sourcesByKind.get(source);
					const ok = Boolean(status?.works);
					return (
						<div
							key={`${capability.key}:${source}:${String(index)}`}
							className={cx(
								"inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-semibold",
								ok
									? "border-[color:color-mix(in_srgb,#22c55e_38%,var(--line))] text-[var(--ink)]"
									: "border-[var(--line)] text-[var(--ink-soft)]",
							)}
						>
							<span className="text-[12px] text-[var(--ink-faint)]">
								{index === 0 ? "primary" : `fallback ${String(index)}`}
							</span>
							<span>{sourceLabel(source)}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function DataSourcesRoute() {
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const accounts = statusQuery.data?.accounts ?? [];
	const selectedAccountId = useSelectedAccountId(accounts);
	const dataSourcesQuery = useQuery({
		queryKey: [...queryKeys.dataSources, selectedAccountId],
		queryFn: () => fetchDataSources(selectedAccountId),
		staleTime: 5 * 60_000,
	});
	const snapshot = dataSourcesQuery.data ?? null;
	const loading = dataSourcesQuery.isFetching;
	const error = dataSourcesQuery.error;
	const sourcesByKind = useMemo(
		() =>
			new Map(
				(snapshot?.sources ?? []).map((source) => [source.source, source]),
			),
		[snapshot],
	);

	return (
		<section className="flex min-h-screen flex-col">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Data Sources</h1>
						<p className={pageSubtitleClass}>
							Live auth, local archive, and automatic fallback order
						</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							className={secondaryButtonClass}
							type="button"
							onClick={() => void dataSourcesQuery.refetch()}
							disabled={loading}
						>
							<RefreshCw className={cx("size-4", loading && "animate-spin")} />
							Refresh
						</button>
					</div>
				</div>
			</header>
			{error ? (
				<div className={errorCopyClass}>
					{error instanceof Error ? error.message : "Data sources unavailable"}
				</div>
			) : null}
			{snapshot ? (
				<>
					<div className="grid border-t border-[var(--line)]">
						{snapshot.sources.map((source) => (
							<SourceCard key={source.source} source={source} />
						))}
					</div>
					<section className="min-h-0 flex-1">
						<header className="border-b border-[var(--line)] px-4 py-3">
							<h2 className="text-[16px] font-bold text-[var(--ink)]">
								Fallbacks
							</h2>
							<p className="text-[13px] text-[var(--ink-soft)]">
								Calls try the next source when the current source cannot serve
								the request.
							</p>
						</header>
						{snapshot.capabilities.map((capability) => (
							<CapabilityRow
								key={capability.key}
								capability={capability}
								sourcesByKind={sourcesByKind}
							/>
						))}
					</section>
				</>
			) : loading ? (
				<div className={statusCopyClass}>Checking data sources...</div>
			) : null}
		</section>
	);
}
