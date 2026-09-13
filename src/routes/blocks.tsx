import { useRouteSearchState } from "#/components/useRouteSearchState";
import { createFileRoute } from "@tanstack/react-router";
import { useDeploymentMode } from "#/lib/deployment-mode";
import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { useDebouncedValue } from "#/components/useDebouncedValue";
import { blockListResponseSchema } from "#/lib/api-contracts";
import { fetchJson, fetchQueryEnvelope, postAction } from "#/lib/api-client";
import { formatCompactNumber } from "#/lib/present";
import { queryKeys } from "#/lib/query-client";
import {
	type BlocksRouteSearch,
	type RouteSearchChange,
	validateBlocksSearch,
} from "#/lib/route-search";
import {
	blockRowBodyClass,
	blockRowClass,
	cx,
	dangerButtonClass,
	emptyStateClass,
	errorCopyClass,
	mutedDotClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	secondaryButtonClass,
	selectFieldClass,
	statusCopyClass,
	textFieldClass,
	textFieldShortClass,
	timestampClass,
} from "#/lib/ui";

export const Route = createFileRoute("/blocks")({
	component: BlocksRoute,
	validateSearch: validateBlocksSearch,
});

function BlocksRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<BlocksRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function BlocksRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: BlocksRouteSearch;
	onSearchChange?: RouteSearchChange<BlocksRouteSearch>;
} = {}) {
	const queryClient = useQueryClient();
	const { readOnly, ready } = useDeploymentMode();
	const { searchState, updateSearch } = useRouteSearchState(
		controlledSearch,
		onSearchChange,
		validateBlocksSearch,
	);
	const accountId = searchState.account;
	const search = searchState.q;
	const searchStateRef = useRef(searchState);
	searchStateRef.current = searchState;
	const [searchInput, setSearchInput] = useState(search);
	const searchInputRef = useRef(search);
	const searchInputDirtyRef = useRef(false);
	const pendingSearchRef = useRef<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [message, setMessage] = useState("");
	const [actionError, setActionError] = useState("");
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const meta = statusQuery.data ?? null;
	const debouncedSearch = useDebouncedValue(searchInput, 180);
	const hasAccountId = accountId.trim().length > 0;
	const isReady = Boolean(meta);
	const blocksQueryKey = [
		...queryKeys.blocks,
		{ accountId, search: debouncedSearch },
	] as const;
	const blocksQuery = useQuery({
		queryKey: blocksQueryKey,
		enabled: hasAccountId,
		queryFn: async ({ signal }) => {
			const params = new URLSearchParams({
				account: accountId,
				limit: "12",
			});
			if (debouncedSearch.trim()) {
				params.set("search", debouncedSearch.trim());
			}
			return fetchJson(
				`/api/blocks?${params.toString()}`,
				{ signal },
				blockListResponseSchema,
				"Blocklist request failed",
			);
		},
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
	const items = blocksQuery.data?.items ?? [];
	const matches = blocksQuery.data?.matches ?? [];
	const blockSyncQuery = useQuery({
		queryKey: [...queryKeys.blockSync, accountId],
		enabled: hasAccountId && ready && !readOnly,
		retry: false,
		queryFn: async () => {
			const data = await postAction({
				kind: "syncBlocks",
				accountId,
			});
			if (data.ok === false || data.transport?.ok === false) {
				throw new Error(data.transport?.output ?? "Block sync failed");
			}
			await queryClient.invalidateQueries({ queryKey: queryKeys.blocks });
			return data;
		},
		staleTime: 5 * 60_000,
	});
	const isSyncing = blockSyncQuery.isFetching;
	const queryError =
		statusQuery.error ?? blocksQuery.error ?? blockSyncQuery.error ?? null;
	const error =
		actionError ||
		(queryError instanceof Error
			? queryError.message
			: queryError
				? "Unable to load blocklist"
				: "");

	useEffect(() => {
		const pendingSearch = pendingSearchRef.current;
		if (pendingSearch !== null) {
			if (search !== pendingSearch) return;
			pendingSearchRef.current = null;
		}
		if (searchInputDirtyRef.current) {
			if (searchInputRef.current !== search) return;
			searchInputDirtyRef.current = false;
		}
		searchInputRef.current = search;
		setSearchInput(search);
	}, [search]);

	useEffect(() => {
		const currentSearch = searchStateRef.current;
		if (currentSearch.q === debouncedSearch) {
			pendingSearchRef.current = null;
			if (searchInputRef.current === debouncedSearch) {
				searchInputDirtyRef.current = false;
			}
			return;
		}
		pendingSearchRef.current = debouncedSearch;
		updateSearch({ ...currentSearch, q: debouncedSearch }, { replace: true });
	}, [debouncedSearch]);

	useEffect(() => {
		if (!meta?.accounts.length) return;
		if (meta.accounts.some((account) => account.id === accountId)) return;
		updateSearch(
			{
				...searchState,
				account: meta.accounts[0]?.id ?? "acct_primary",
			},
			{ replace: true },
		);
	}, [accountId, meta]);

	useEffect(() => {
		const data = blockSyncQuery.data;
		if (!data || data.transport?.output?.includes("disabled")) return;
		setMessage(
			data.transport?.output ??
				`Synced ${String(data.syncedCount ?? 0)} remote blocks`,
		);
	}, [blockSyncQuery.data]);

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0
				? `${String(items.length)} blocked profiles · loading transport...`
				: "Loading local blocklist...";
		}
		if (isSyncing)
			return `Syncing remote blocklist · ${meta.transport.statusText}`;
		return `${String(items.length)} blocked profiles · ${meta.transport.statusText}`;
	}, [isSyncing, items.length, meta]);

	async function submit(
		kind: "blockProfile" | "unblockProfile",
		query: string,
	) {
		const normalized = query.trim();
		if (!normalized) return;

		setIsSubmitting(true);
		setActionError("");
		setMessage("");

		try {
			const data = await postAction({
				kind,
				accountId,
				query: normalized,
			});
			if (data.ok === false || data.transport?.ok === false) {
				setActionError(data.transport?.output ?? "Blocklist action failed");
				return;
			}

			setMessage(
				`${kind === "blockProfile" ? "Blocked" : "Unblocked"} @${
					data.profile?.handle ?? normalized.replace(/^@/, "")
				} · ${data.transport?.output ?? "local"}`,
			);
			await queryClient.invalidateQueries({ queryKey: queryKeys.blocks });
		} catch (submitError) {
			setActionError(
				submitError instanceof Error
					? submitError.message
					: "Blocklist action failed",
			);
		} finally {
			setIsSubmitting(false);
		}
	}

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Blocks</h1>
						<h2 className={cx(pageSubtitleClass, "text-[14px]")}>
							{readOnly
								? "Read the cached blocklist."
								: "Maintain a clean blocklist locally."}
						</h2>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<select
						className={cx(selectFieldClass, textFieldShortClass)}
						disabled={!isReady}
						onChange={(event) =>
							updateSearch({ ...searchState, account: event.target.value })
						}
						value={accountId}
					>
						{meta?.accounts.map((account) => (
							<option key={account.id} value={account.id}>
								{account.handle}
							</option>
						))}
					</select>
					<input
						className={cx(textFieldClass, "flex-1 min-w-[200px]")}
						disabled={!hasAccountId}
						onChange={(event) => {
							const nextSearch = event.target.value;
							searchInputRef.current = nextSearch;
							searchInputDirtyRef.current =
								nextSearch !== searchStateRef.current.q;
							setSearchInput(nextSearch);
						}}
						placeholder="Handle, name, bio, or Twitter URL"
						value={searchInput}
					/>
					<button
						className={primaryButtonClass}
						disabled={!hasAccountId || isSubmitting || !searchInput.trim()}
						hidden={readOnly}
						onClick={() => void submit("blockProfile", searchInput)}
						type="button"
					>
						{isSubmitting ? "Working..." : "Block"}
					</button>
				</div>
			</header>

			{message ? <p className={statusCopyClass}>{message}</p> : null}
			{error ? <p className={errorCopyClass}>{error}</p> : null}

			{matches.length > 0 ? (
				<section className="flex flex-col">
					<h2 className="px-4 pt-3 pb-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
						Search matches
					</h2>
					{matches.map((match) => (
						<article className={blockRowClass} key={match.profile.id}>
							<AvatarChip
								avatarUrl={match.profile.avatarUrl}
								hue={match.profile.avatarHue}
								name={match.profile.displayName}
								profileId={match.profile.id}
							/>
							<div className={blockRowBodyClass}>
								<div className="flex items-center justify-between gap-2">
									<div className="flex min-w-0 flex-col">
										<strong className="truncate text-[15px] text-[var(--ink)]">
											{match.profile.displayName}
										</strong>
										<div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--ink-soft)]">
											<span>@{match.profile.handle}</span>
											<span className={mutedDotClass} />
											<span>
												{formatCompactNumber(match.profile.followersCount)}{" "}
												followers
											</span>
										</div>
									</div>
									<button
										className={
											match.isBlocked ? secondaryButtonClass : dangerButtonClass
										}
										hidden={readOnly}
										onClick={() =>
											void submit(
												match.isBlocked ? "unblockProfile" : "blockProfile",
												match.profile.id,
											)
										}
										type="button"
									>
										{match.isBlocked ? "Unblock" : "Block"}
									</button>
								</div>
								<p className="text-[14px] leading-[1.4] text-[var(--ink)]">
									{match.profile.bio}
								</p>
							</div>
						</article>
					))}
				</section>
			) : null}

			<section className="flex flex-col">
				{items.length === 0 && matches.length === 0 ? (
					<div className={emptyStateClass}>No blocks in this account.</div>
				) : null}
				{items.map((item) => (
					<article
						className={blockRowClass}
						key={item.accountId + item.profile.id}
					>
						<AvatarChip
							avatarUrl={item.profile.avatarUrl}
							hue={item.profile.avatarHue}
							name={item.profile.displayName}
							profileId={item.profile.id}
						/>
						<div className={blockRowBodyClass}>
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 flex-col">
									<strong className="truncate text-[15px] text-[var(--ink)]">
										{item.profile.displayName}
									</strong>
									<div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--ink-soft)]">
										<span>@{item.profile.handle}</span>
										<span className={mutedDotClass} />
										<span>{item.accountHandle}</span>
										<span className={mutedDotClass} />
										<span>
											{formatCompactNumber(item.profile.followersCount)}{" "}
											followers
										</span>
									</div>
								</div>
								<button
									className={secondaryButtonClass}
									hidden={readOnly}
									onClick={() => void submit("unblockProfile", item.profile.id)}
									type="button"
								>
									Unblock
								</button>
							</div>
							{item.profile.bio ? (
								<p className="text-[14px] leading-[1.4] text-[var(--ink)]">
									{item.profile.bio}
								</p>
							) : null}
							<p className={timestampClass}>
								Blocked {new Date(item.blockedAt).toLocaleString()} ·{" "}
								{item.source}
							</p>
						</div>
					</article>
				))}
			</section>
		</>
	);
}
