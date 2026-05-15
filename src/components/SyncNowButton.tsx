import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { postSync } from "#/lib/api-client";
import { cx } from "#/lib/ui";
import type { WebSyncKind, WebSyncResponse } from "#/lib/web-sync";

interface SyncNowButtonProps {
	kind: WebSyncKind;
	label: string;
	onSynced: (result: WebSyncResponse) => void;
}

export function SyncNowButton({ kind, label, onSynced }: SyncNowButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function syncNow() {
		setSyncing(true);
		setError(null);
		setMessage(null);
		try {
			const data = await postSync(kind);
			if (!data.ok) throw new Error(data.summary);
			setMessage(data.summary);
			onSynced(data);
		} catch (syncError) {
			setError(syncError instanceof Error ? syncError.message : "Sync failed");
		} finally {
			setSyncing(false);
		}
	}

	return (
		<div className="flex shrink-0 items-center gap-2">
			<button
				type="button"
				className={cx(
					"inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] font-semibold text-[var(--ink)] transition-[background,border-color,color,transform] duration-150 hover:border-[color:color-mix(in_srgb,var(--accent)_45%,var(--line))] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] active:scale-[0.98] disabled:cursor-wait disabled:opacity-65",
					syncing && "text-[var(--ink-soft)]",
				)}
				aria-label={syncing ? `${label}: syncing` : label}
				disabled={syncing}
				onClick={syncNow}
			>
				<RefreshCw
					className={cx("size-4", syncing && "animate-spin")}
					strokeWidth={2}
				/>
				<span className="hidden sm:inline">
					{syncing ? "Syncing..." : label}
				</span>
			</button>
			<span
				className={cx(
					"hidden max-w-[190px] truncate text-[12px] sm:inline",
					error ? "text-[var(--alert)]" : "text-[var(--ink-soft)]",
				)}
				role="status"
			>
				{error ?? message ?? ""}
			</span>
		</div>
	);
}
