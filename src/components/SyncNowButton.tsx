import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postSync } from "#/lib/api-client";
import { useDeploymentMode } from "#/lib/deployment-mode";
import type { AccountRecord } from "#/lib/types";
import { cx, selectFieldClass } from "#/lib/ui";
import type {
	WebSyncKind,
	WebSyncOptions,
	WebSyncResponse,
} from "#/lib/web-sync";
import {
	defaultAccountId as getDefaultAccountId,
	setStoredAccountId,
	useSelectedAccountId,
} from "./account-selection";

interface SyncNowButtonProps {
	kind: WebSyncKind;
	label: string;
	accounts?: AccountRecord[];
	onSynced: (result: WebSyncResponse) => void;
	allowAutoSync?: boolean;
	autoSyncBlocked?: boolean;
	showAccountPicker?: boolean;
	syncOptions?: WebSyncOptions;
}

const AUTO_SYNC_INTERVALS = [
	{ label: "5m", value: 5 * 60_000 },
	{ label: "10m", value: 10 * 60_000 },
	{ label: "15m", value: 15 * 60_000 },
	{ label: "30m", value: 30 * 60_000 },
	{ label: "1h", value: 60 * 60_000 },
] as const;
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 10 * 60_000;
const MAX_AUTO_SYNC_BACKOFF_MS = 60 * 60_000;

interface StoredAutoSyncSettings {
	enabled: boolean;
	intervalMs: number;
}

interface AutoSyncSettings extends StoredAutoSyncSettings {
	key: string;
}

function autoSyncStorageKey(kind: WebSyncKind, accountId: string | undefined) {
	return `birdclaw:auto-sync:${kind}:${accountId ?? "default"}`;
}

function validAutoSyncInterval(value: unknown): value is number {
	return AUTO_SYNC_INTERVALS.some((option) => option.value === value);
}

function readAutoSyncSettings(key: string): StoredAutoSyncSettings {
	try {
		const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
			enabled?: unknown;
			intervalMs?: unknown;
		} | null;
		return {
			enabled: value?.enabled === true,
			intervalMs: validAutoSyncInterval(value?.intervalMs)
				? value.intervalMs
				: DEFAULT_AUTO_SYNC_INTERVAL_MS,
		};
	} catch {
		return { enabled: false, intervalMs: DEFAULT_AUTO_SYNC_INTERVAL_MS };
	}
}

export function SyncNowButton(props: SyncNowButtonProps) {
	const { readOnly, ready } = useDeploymentMode();
	if (readOnly || !ready) return null;
	return <WritableSyncNowButton {...props} />;
}

function WritableSyncNowButton({
	kind,
	label,
	accounts,
	onSynced,
	allowAutoSync = false,
	autoSyncBlocked = false,
	showAccountPicker = false,
	syncOptions,
}: SyncNowButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const syncingRef = useRef(false);
	const onSyncedRef = useRef(onSynced);
	const [autoSyncing, setAutoSyncing] = useState(false);
	const [autoSyncError, setAutoSyncError] = useState<string | null>(null);
	const [autoFailureCount, setAutoFailureCount] = useState(0);
	const [autoCycle, setAutoCycle] = useState(0);
	const [lastAutoSyncedAt, setLastAutoSyncedAt] = useState<number | null>(null);
	const [nextAutoSyncAt, setNextAutoSyncAt] = useState<number | null>(null);
	const accountList = accounts ?? [];
	const globalAccountId = useSelectedAccountId(accounts);
	const defaultAccountId = useMemo(
		() => getDefaultAccountId(accounts),
		[accounts],
	);
	const accountId = globalAccountId ?? defaultAccountId;
	const autoSyncKey = autoSyncStorageKey(kind, accountId);
	const autoSyncKeyRef = useRef(autoSyncKey);
	autoSyncKeyRef.current = autoSyncKey;
	const [autoSettings, setAutoSettings] = useState<AutoSyncSettings>({
		key: "",
		enabled: false,
		intervalMs: DEFAULT_AUTO_SYNC_INTERVAL_MS,
	});
	const autoSettingsReady = autoSettings.key === autoSyncKey;
	const waitingForAccount =
		accounts === undefined && (showAccountPicker || kind !== "timeline");
	const disabled = syncing || waitingForAccount;
	const statusMessage = waitingForAccount
		? "Loading account"
		: (error ?? message ?? "");
	const autoStatusMessage = autoSyncError
		? `Auto sync failed: ${autoSyncError}`
		: autoSyncing
			? "Auto syncing..."
			: lastAutoSyncedAt
				? `Last auto sync ${new Date(lastAutoSyncedAt).toLocaleTimeString()}`
				: nextAutoSyncAt
					? `Next sync ${new Date(nextAutoSyncAt).toLocaleTimeString()}`
					: autoSettings.enabled
						? "Auto sync waiting"
						: "Auto sync off";

	useEffect(() => {
		onSyncedRef.current = onSynced;
	}, [onSynced]);

	useEffect(() => {
		const stored = readAutoSyncSettings(autoSyncKey);
		setAutoSettings({ key: autoSyncKey, ...stored });
		setAutoSyncError(null);
		setAutoSyncing(false);
		setAutoFailureCount(0);
		setLastAutoSyncedAt(null);
		setNextAutoSyncAt(null);
		setAutoCycle((current) => current + 1);
	}, [autoSyncKey]);

	function selectAccount(accountId: string) {
		setStoredAccountId(accountId);
	}

	const syncNow = useCallback(
		async (source: "manual" | "auto"): Promise<boolean> => {
			if (
				syncingRef.current ||
				waitingForAccount ||
				(source === "auto" && autoSyncBlocked)
			) {
				return false;
			}
			const launchedAutoSyncKey =
				source === "auto" ? autoSyncKeyRef.current : null;
			syncingRef.current = true;
			setSyncing(true);
			if (source === "auto") {
				setAutoSyncing(true);
				setAutoSyncError(null);
			} else {
				setError(null);
				setMessage(null);
			}
			try {
				const data = await postSync(kind, accountId, syncOptions);
				if (!data.ok) throw new Error(data.summary);
				if (
					launchedAutoSyncKey !== null &&
					autoSyncKeyRef.current !== launchedAutoSyncKey
				) {
					return false;
				}
				if (source === "auto") {
					setLastAutoSyncedAt(Date.now());
					setAutoFailureCount(0);
				} else {
					setMessage(data.summary);
				}
				onSyncedRef.current(data);
				return true;
			} catch (syncError) {
				if (
					launchedAutoSyncKey !== null &&
					autoSyncKeyRef.current !== launchedAutoSyncKey
				) {
					return false;
				}
				const syncMessage =
					syncError instanceof Error ? syncError.message : "Sync failed";
				if (source === "auto") {
					setAutoSyncError(syncMessage);
					setAutoFailureCount((current) => current + 1);
				} else {
					setError(syncMessage);
				}
				return false;
			} finally {
				syncingRef.current = false;
				setSyncing(false);
				if (source === "auto") setAutoSyncing(false);
			}
		},
		[accountId, autoSyncBlocked, kind, syncOptions, waitingForAccount],
	);

	useEffect(() => {
		if (
			!allowAutoSync ||
			!autoSettingsReady ||
			!autoSettings.enabled ||
			autoSyncBlocked ||
			waitingForAccount
		) {
			setNextAutoSyncAt(null);
			return;
		}

		const delayMs = Math.min(
			autoSettings.intervalMs * 2 ** autoFailureCount,
			MAX_AUTO_SYNC_BACKOFF_MS,
		);
		setNextAutoSyncAt(Date.now() + delayMs);
		const timer = window.setTimeout(() => {
			if (document.visibilityState === "hidden" || syncingRef.current) {
				setAutoCycle((current) => current + 1);
				return;
			}
			void syncNow("auto").finally(() => {
				setAutoCycle((current) => current + 1);
			});
		}, delayMs);

		return () => window.clearTimeout(timer);
	}, [
		allowAutoSync,
		autoCycle,
		autoFailureCount,
		autoSettings.enabled,
		autoSettings.intervalMs,
		autoSettingsReady,
		autoSyncBlocked,
		syncNow,
		waitingForAccount,
	]);

	function updateAutoSettings(next: StoredAutoSyncSettings) {
		const settings = { key: autoSyncKey, ...next };
		setAutoSettings(settings);
		window.localStorage.setItem(
			autoSyncKey,
			JSON.stringify({ enabled: next.enabled, intervalMs: next.intervalMs }),
		);
		setAutoSyncError(null);
		setAutoFailureCount(0);
		setLastAutoSyncedAt(null);
		setAutoCycle((current) => current + 1);
	}

	return (
		<div
			className={cx(
				"flex shrink-0 flex-wrap items-center justify-end gap-2",
				allowAutoSync && "w-full lg:w-auto",
			)}
		>
			{showAccountPicker && accountList.length > 1 ? (
				<select
					aria-label="Sync account"
					className={cx(selectFieldClass, "h-9 w-[132px]!")}
					disabled={syncing}
					onChange={(event) => selectAccount(event.target.value)}
					value={accountId ?? ""}
				>
					{accountList.map((account) => (
						<option key={account.id} value={account.id}>
							{account.handle}
						</option>
					))}
				</select>
			) : null}
			<button
				type="button"
				className={cx(
					"inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] font-semibold text-[var(--ink)] transition-[background,border-color,color,transform] duration-150 hover:border-[color:color-mix(in_srgb,var(--accent)_45%,var(--line))] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] active:scale-[0.98] disabled:opacity-65",
					syncing && "text-[var(--ink-soft)]",
					"disabled:cursor-wait",
				)}
				aria-label={syncing ? `${label}: syncing` : label}
				disabled={disabled}
				onClick={() => void syncNow("manual")}
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
				{statusMessage}
			</span>
			{allowAutoSync && autoSettingsReady ? (
				<>
					<label className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)]">
						<input
							aria-label={`Auto sync ${kind}`}
							type="checkbox"
							checked={autoSettings.enabled}
							disabled={waitingForAccount}
							onChange={(event) =>
								updateAutoSettings({
									enabled: event.currentTarget.checked,
									intervalMs: autoSettings.intervalMs,
								})
							}
						/>
						Auto sync
					</label>
					<select
						aria-label={`${label} auto-sync interval`}
						className={cx(selectFieldClass, "h-9 w-[70px]!")}
						disabled={!autoSettings.enabled}
						onChange={(event) =>
							updateAutoSettings({
								enabled: autoSettings.enabled,
								intervalMs: Number(event.currentTarget.value),
							})
						}
						value={autoSettings.intervalMs}
					>
						{AUTO_SYNC_INTERVALS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<span
						className={cx(
							"max-w-[190px] truncate text-[12px]",
							autoSyncError ? "text-[var(--alert)]" : "text-[var(--ink-soft)]",
						)}
						role="status"
					>
						{autoStatusMessage}
					</span>
				</>
			) : null}
		</div>
	);
}
