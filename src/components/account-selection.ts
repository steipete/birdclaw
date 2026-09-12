import { useEffect, useMemo, useState } from "react";
import type { AccountRecord } from "#/lib/types";

const STORAGE_KEY = "birdclaw:selected-account-id";
const CHANGE_EVENT = "birdclaw-account-change";

export function useQueryAccount(status: {
	data?: { accounts: AccountRecord[] };
	isSuccess: boolean;
	isError: boolean;
}) {
	const selectedAccountId = useSelectedAccountId(status.data?.accounts, {
		allowStoredBeforeAccounts: true,
	});
	return {
		selectedAccountId,
		accountSelectionSettled:
			Boolean(selectedAccountId) || status.isSuccess || status.isError,
	};
}

export function defaultAccountId(accounts: AccountRecord[] | undefined) {
	if (!accounts?.length) return undefined;
	return accounts.find((account) => account.isDefault)?.id ?? accounts[0]?.id;
}

function readStoredAccountId() {
	if (typeof window === "undefined") return undefined;
	return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
}

export function setStoredAccountId(accountId: string) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(STORAGE_KEY, accountId);
	window.dispatchEvent(
		new CustomEvent(CHANGE_EVENT, {
			detail: { accountId },
		}),
	);
}

export function useSelectedAccountId(
	accounts: AccountRecord[] | undefined,
	options: { allowStoredBeforeAccounts?: boolean } = {},
) {
	const fallbackAccountId = useMemo(
		() => defaultAccountId(accounts),
		[accounts],
	);
	const [selectedAccountId, setSelectedAccountId] = useState<
		string | undefined
	>(() => readStoredAccountId());

	useEffect(() => {
		const onChange = (event: Event) => {
			const custom = event as CustomEvent<{ accountId?: string }>;
			setSelectedAccountId(custom.detail?.accountId ?? readStoredAccountId());
		};
		const onStorage = () => setSelectedAccountId(readStoredAccountId());
		window.addEventListener(CHANGE_EVENT, onChange);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(CHANGE_EVENT, onChange);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	useEffect(() => {
		if (!accounts?.length || !fallbackAccountId) return;
		const current = readStoredAccountId();
		const valid = current && accounts.some((account) => account.id === current);
		if (!valid) {
			setStoredAccountId(fallbackAccountId);
			setSelectedAccountId(fallbackAccountId);
		}
	}, [accounts, fallbackAccountId]);

	if (!accounts && options.allowStoredBeforeAccounts) return selectedAccountId;
	return selectedAccountId &&
		accounts?.some((account) => account.id === selectedAccountId)
		? selectedAccountId
		: fallbackAccountId;
}
