import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { formatCompactNumber } from "#/lib/present";
import type {
	BlockItem,
	BlockListResponse,
	BlockSearchItem,
	QueryEnvelope,
} from "#/lib/types";
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
	textFieldWideClass,
	timestampClass,
} from "#/lib/ui";

export const Route = createFileRoute("/blocks")({
	component: BlocksRoute,
});

function BlocksRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [accountId, setAccountId] = useState<string>("acct_primary");
	const [search, setSearch] = useState("");
	const [items, setItems] = useState<BlockItem[]>([]);
	const [matches, setMatches] = useState<BlockSearchItem[]>([]);
	const [refreshTick, setRefreshTick] = useState(0);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const hasAccountId = accountId.trim().length > 0;
	const isReady = Boolean(meta);

	useEffect(() => {
		const controller = new AbortController();

		fetch("/api/status", { signal: controller.signal })
			.then((response) => response.json())
			.then((data: QueryEnvelope) => {
				setMeta(data);
				setAccountId(data.accounts[0]?.id ?? "acct_primary");
				setError("");
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
				setError(
					error instanceof Error
						? error.message
						: "Unable to load blocklist status",
				);
			});

		return () => {
			controller.abort();
		};
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const params = new URLSearchParams({
			account: accountId,
			limit: "12",
			refresh: String(refreshTick),
		});
		if (search.trim()) {
			params.set("search", search.trim());
		}

		fetch(`/api/blocks?${params.toString()}`, { signal: controller.signal })
			.then((response) => response.json())
			.then((data: BlockListResponse) => {
				setItems(data.items);
				setMatches(data.matches);
				setError("");
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
				setError(
					error instanceof Error ? error.message : "Unable to load blocklist",
				);
			});

		return () => {
			controller.abort();
		};
	}, [accountId, refreshTick, search]);

	useEffect(() => {
		if (!hasAccountId) {
			return;
		}

		const controller = new AbortController();
		setIsSyncing(true);

		fetch("/api/action", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "syncBlocks",
				accountId,
			}),
			signal: controller.signal,
		})
			.then((response) => response.json())
			.then(
				(data: {
					ok?: boolean;
					synced?: boolean;
					syncedCount?: number;
					transport?: { ok?: boolean; output?: string };
				}) => {
					if (data.ok === false) {
						setError(data.transport?.output ?? "Block sync failed");
						return;
					}
					setRefreshTick((value) => value + 1);
					if (data.transport?.output?.includes("disabled")) {
						return;
					}
					setMessage(
						data.transport?.output ??
							`Synced ${String(data.syncedCount ?? 0)} remote blocks`,
					);
				},
			)
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
				setError(error instanceof Error ? error.message : "Block sync failed");
			})
			.finally(() => setIsSyncing(false));

		return () => {
			controller.abort();
		};
	}, [accountId, hasAccountId]);

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
		setError("");
		setMessage("");

		try {
			const response = await fetch("/api/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind,
					accountId,
					query: normalized,
				}),
			});
			const data = (await response.json()) as {
				ok?: boolean;
				profile?: { handle?: string };
				transport?: { ok?: boolean; output?: string };
			};
			if (data.ok === false || data.transport?.ok === false) {
				setError(data.transport?.output ?? "Blocklist action failed");
				return;
			}

			setMessage(
				`${kind === "blockProfile" ? "Blocked" : "Unblocked"} @${
					data.profile?.handle ?? normalized.replace(/^@/, "")
				} · ${data.transport?.output ?? "local"}`,
			);
			setRefreshTick((value) => value + 1);
		} catch (submitError) {
			setError(
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
							Maintain a clean blocklist locally.
						</h2>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<select
						className={cx(selectFieldClass, textFieldShortClass)}
						disabled={!isReady}
						onChange={(event) => setAccountId(event.target.value)}
						value={accountId}
					>
						{meta?.accounts.map((account) => (
							<option key={account.id} value={account.id}>
								{account.handle}
							</option>
						))}
					</select>
					<input
						className={cx(
							textFieldClass,
							textFieldWideClass,
							"flex-1 min-w-[200px]",
						)}
						disabled={!hasAccountId}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Handle, name, bio, or Twitter URL"
						value={search}
					/>
					<button
						className={primaryButtonClass}
						disabled={!hasAccountId || isSubmitting || !search.trim()}
						onClick={() => void submit("blockProfile", search)}
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
