import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
	BlockItem,
	BlockListResponse,
	BlockSearchItem,
	QueryEnvelope,
} from "#/lib/types";

export const Route = createFileRoute("/blocks")({
	component: BlocksRoute,
});

function formatFollowers(value: number) {
	return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function BlocksRoute() {
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [accountId, setAccountId] = useState<string>("acct_primary");
	const [search, setSearch] = useState("");
	const [items, setItems] = useState<BlockItem[]>([]);
	const [matches, setMatches] = useState<BlockSearchItem[]>([]);
	const [refreshTick, setRefreshTick] = useState(0);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const isReady = Boolean(meta);

	useEffect(() => {
		const controller = new AbortController();

		fetch("/api/status", { signal: controller.signal })
			.then((response) => response.json())
			.then((data: QueryEnvelope) => {
				setMeta(data);
				setAccountId(data.accounts[0]?.id ?? "acct_primary");
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
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const url = new URL("/api/blocks", window.location.origin);
		url.searchParams.set("account", accountId);
		url.searchParams.set("limit", "12");
		url.searchParams.set("refresh", String(refreshTick));
		if (search.trim()) {
			url.searchParams.set("search", search.trim());
		}

		fetch(url, { signal: controller.signal })
			.then((response) => response.json())
			.then((data: BlockListResponse) => {
				setItems(data.items);
				setMatches(data.matches);
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
	}, [accountId, refreshTick, search]);

	const subtitle = useMemo(() => {
		if (!meta) return "Loading local blocklist...";
		return `${items.length} blocked profiles in view · ${meta.transport.statusText}`;
	}, [items.length, meta]);

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
				profile?: { handle?: string };
				transport?: { output?: string };
			};

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
		<main className="page-wrap">
			<section className="hero-shell">
				<div>
					<p className="eyebrow">blocks</p>
					<h2 className="hero-title">Maintain a clean blocklist locally.</h2>
					<p className="hero-copy">{subtitle}</p>
				</div>
				<div className="hero-controls hero-controls-blocks">
					<select
						className="text-field text-field-short"
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
						className="text-field"
						disabled={!isReady}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Handle, name, bio, or X URL"
						value={search}
					/>
					<button
						className="action-button"
						disabled={!isReady || isSubmitting || !search.trim()}
						onClick={() => void submit("blockProfile", search)}
						type="button"
					>
						{isSubmitting ? "Working..." : "Block"}
					</button>
				</div>
			</section>

			{message ? <p className="timestamp">{message}</p> : null}
			{error ? <p className="error-copy">{error}</p> : null}

			{matches.length > 0 ? (
				<section className="stack-grid">
					{matches.map((match) => (
						<article className="content-card block-card" key={match.profile.id}>
							<div className="card-header">
								<div className="identity-block">
									<div
										className="avatar-chip"
										style={
											{
												"--avatar-hue": match.profile.avatarHue,
											} as CSSProperties
										}
									>
										{match.profile.displayName
											.split(" ")
											.map((part) => part[0] ?? "")
											.join("")
											.slice(0, 2)}
									</div>
									<div>
										<strong>{match.profile.displayName}</strong>
										<div className="meta-row">
											<span>@{match.profile.handle}</span>
											<span className="muted-dot" />
											<span>
												{formatFollowers(match.profile.followersCount)}{" "}
												followers
											</span>
										</div>
									</div>
								</div>
								<button
									className="action-button"
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
							<p>{match.profile.bio}</p>
						</article>
					))}
				</section>
			) : null}

			<section className="stack-grid">
				{items.map((item) => (
					<article
						className="content-card block-card"
						key={item.accountId + item.profile.id}
					>
						<div className="card-header">
							<div className="identity-block">
								<div
									className="avatar-chip"
									style={
										{
											"--avatar-hue": item.profile.avatarHue,
										} as CSSProperties
									}
								>
									{item.profile.displayName
										.split(" ")
										.map((part) => part[0] ?? "")
										.join("")
										.slice(0, 2)}
								</div>
								<div>
									<strong>{item.profile.displayName}</strong>
									<div className="meta-row">
										<span>@{item.profile.handle}</span>
										<span className="muted-dot" />
										<span>{item.accountHandle}</span>
										<span className="muted-dot" />
										<span>
											{formatFollowers(item.profile.followersCount)} followers
										</span>
									</div>
								</div>
							</div>
							<button
								className="action-button"
								onClick={() => void submit("unblockProfile", item.profile.id)}
								type="button"
							>
								Unblock
							</button>
						</div>
						<p>{item.profile.bio}</p>
						<p className="timestamp">
							Blocked {new Date(item.blockedAt).toLocaleString()} ·{" "}
							{item.source}
						</p>
					</article>
				))}
			</section>
		</main>
	);
}
