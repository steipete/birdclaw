import { Effect } from "effect";
import { getAuthenticatedBirdAccountEffect } from "./bird";
import { getNativeDb } from "./db";
import { getBirdProfileName } from "./bird-profile";
import type { LiveDataSourcesResponse } from "./api-contracts";
import type {
	LiveDataSourceAccount,
	LiveDataSourceCapability,
	LiveDataSourceStatus,
} from "./types";
import {
	getTransportStatusEffect,
	lookupAuthenticatedOAuth2UserEffect,
	readXurlOAuth2AccountsEffect,
} from "./xurl";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function readLocalAccounts(): LiveDataSourceAccount[] {
	const db = getNativeDb();
	const rows = db
		.prepare(
			`
      select id, handle, external_user_id, is_default
      from accounts
      order by is_default desc, lower(handle) asc
      `,
		)
		.all() as Array<{
		id: string;
		handle: string;
		external_user_id: string | null;
		is_default: number;
	}>;
	return rows.map((row) => ({
		id: row.external_user_id ?? row.id,
		handle: row.handle,
		username: row.handle.replace(/^@/, ""),
		isDefault: row.is_default === 1,
	}));
}

function getBirdclawStatusEffect(): Effect.Effect<LiveDataSourceStatus, never> {
	return Effect.try({
		try: () => readLocalAccounts(),
		catch: (error) => error,
	}).pipe(
		Effect.map((accounts) => ({
			source: "birdclaw" as const,
			label: "Birdclaw local",
			works: true,
			installed: true,
			status: "ok" as const,
			detail:
				accounts.length > 0
					? `${accounts.length.toString()} local account${accounts.length === 1 ? "" : "s"}`
					: "local database ready; no accounts imported yet",
			accounts,
		})),
		Effect.catchAll((error) =>
			Effect.succeed({
				source: "birdclaw" as const,
				label: "Birdclaw local",
				works: false,
				installed: true,
				status: "error" as const,
				detail: errorMessage(error),
				accounts: [],
			}),
		),
	);
}

function getBirdStatusEffect({
	accountId,
}: {
	accountId?: string;
} = {}): Effect.Effect<LiveDataSourceStatus, never> {
	const profileName = getBirdProfileName(getNativeDb(), accountId);
	if (!profileName) {
		return Effect.succeed({
			source: "bird" as const,
			label: "bird",
			works: false,
			status: "error" as const,
			detail:
				"bird_profile_name is required to use bird; run birdclaw accounts set-bird-profile first",
			accounts: [],
		});
	}
	return getAuthenticatedBirdAccountEffect(profileName).pipe(
		Effect.map((account) => ({
			source: "bird" as const,
			label: "bird",
			works: true,
			installed: true,
			status: "ok" as const,
			detail: `authenticated as @${account.username}`,
			accounts: [
				{
					...(account.id ? { id: account.id } : {}),
					username: account.username,
					handle: `@${account.username}`,
				},
			],
		})),
		Effect.catchAll((error) =>
			Effect.succeed({
				source: "bird" as const,
				label: "bird",
				works: false,
				status: "error" as const,
				detail: errorMessage(error),
				accounts: [],
			}),
		),
	);
}

function getXurlStatusEffect(): Effect.Effect<LiveDataSourceStatus, never> {
	return Effect.gen(function* () {
		const transport = yield* getTransportStatusEffect();
		const oauth2Accounts = yield* readXurlOAuth2AccountsEffect();
		const authenticated = yield* lookupAuthenticatedOAuth2UserEffect().pipe(
			Effect.catchAll(() => Effect.succeed(null)),
		);
		const authenticatedAccount =
			authenticated && typeof authenticated === "object"
				? ({
						...(typeof authenticated.id === "string"
							? { id: authenticated.id }
							: {}),
						...(typeof authenticated.username === "string"
							? {
									username: authenticated.username,
									handle: `@${authenticated.username}`,
								}
							: {}),
					} satisfies LiveDataSourceAccount)
				: undefined;
		const accounts: LiveDataSourceAccount[] = [
			...(authenticatedAccount ? [authenticatedAccount] : []),
			...oauth2Accounts,
		];
		const deduped = accounts.filter(
			(account, index) =>
				accounts.findIndex(
					(candidate) =>
						(candidate.app ?? "") === (account.app ?? "") &&
						(candidate.username ?? candidate.handle ?? "") ===
							(account.username ?? account.handle ?? ""),
				) === index,
		);
		const works = transport.availableTransport === "xurl";
		return {
			source: "xurl" as const,
			label: "xurl",
			works,
			installed: transport.installed,
			status: works ? ("ok" as const) : ("warning" as const),
			detail: transport.statusText,
			accounts: deduped,
		};
	}).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				source: "xurl" as const,
				label: "xurl",
				works: false,
				status: "error" as const,
				detail: errorMessage(error),
				accounts: [],
			}),
		),
	);
}

const capabilities: LiveDataSourceCapability[] = [
	{
		key: "timeline",
		label: "Home timeline",
		primary: "bird",
		fallbacks: ["birdclaw"],
		notes: "Use explicit xurl mode for start-time bounded backfills.",
	},
	{
		key: "mentions",
		label: "Mentions",
		primary: "bird",
		fallbacks: ["birdclaw"],
		notes: "Use explicit xurl mode when since/start cursors are required.",
	},
	{
		key: "search",
		label: "Fresh search",
		primary: "bird",
		fallbacks: ["xurl", "birdclaw"],
		notes: "dated searches require xurl.",
	},
	{
		key: "dms",
		label: "DMs",
		primary: "birdclaw",
		fallbacks: ["xurl"],
		notes:
			"Current bird CLI lacks DMs; explicit xurl mode can import accepted DM events.",
	},
	{
		key: "follow-graph",
		label: "Followers / following",
		primary: "bird",
		fallbacks: ["xurl", "birdclaw"],
	},
];

export function getLiveDataSourcesEffect({
	accountId,
}: {
	accountId?: string;
} = {}): Effect.Effect<LiveDataSourcesResponse, never> {
	return Effect.gen(function* () {
		const sources = yield* Effect.all(
			[
				getBirdclawStatusEffect(),
				getBirdStatusEffect({ accountId }),
				getXurlStatusEffect(),
			],
			{ concurrency: "unbounded" },
		);
		return {
			generatedAt: new Date().toISOString(),
			sources,
			capabilities,
		};
	});
}
