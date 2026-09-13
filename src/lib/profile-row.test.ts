import { describe, expect, it } from "vitest";
import { parseJsonObject } from "./json-codec";
import {
	normalizeProfileHandle,
	nullableProfileFromDbRow,
	profileFromDbRow,
	profileHandleKey,
	profileEntityUrls,
} from "./profile-row";

describe("profile database row codec", () => {
	it("preserves URL entity precedence, order, and the requested block", () => {
		const profile = profileFromDbRow({
			entities_json: JSON.stringify({
				url: { urls: [{ url: "https://profile.example" }] },
				description: {
					urls: [
						null,
						"invalid",
						{},
						{ expandedUrl: "", expanded_url: "ignored" },
						{ expandedUrl: 42, url: "ignored" },
						{ expandedUrl: "https://first.example", expanded_url: "ignored" },
						{ expandedUrl: null, expanded_url: "https://second.example" },
						{ url: "https://first.example" },
					],
				},
			}),
		});
		expect(profileEntityUrls(profile)).toEqual([
			"https://first.example",
			"https://second.example",
			"https://first.example",
		]);
		expect(profileEntityUrls(profile, "url")).toEqual([
			"https://profile.example",
		]);
		for (const description of [null, "invalid", {}, { urls: {} }]) {
			expect(
				profileEntityUrls({ ...profile, entities: { description } }),
			).toEqual([]);
		}
	});

	it("maps profile columns and rejects malformed object metadata", () => {
		expect(
			profileFromDbRow({
				id: "profile_1",
				handle: "Alice",
				display_name: "Alice Example",
				bio: "Builder",
				followers_count: "42",
				following_count: null,
				avatar_hue: "not-a-number",
				avatar_url: "",
				location: "NYC",
				url: "https://example.com",
				verified_type: "blue",
				entities_json: '{"description":{"urls":[]}}',
				created_at: "2026-01-01T00:00:00.000Z",
			}),
		).toEqual({
			id: "profile_1",
			handle: "Alice",
			displayName: "Alice Example",
			bio: "Builder",
			followersCount: 42,
			followingCount: 0,
			avatarHue: 0,
			location: "NYC",
			url: "https://example.com",
			verifiedType: "blue",
			entities: { description: { urls: [] } },
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(parseJsonObject("[]")).toBeUndefined();
		expect(parseJsonObject("null")).toBeUndefined();
		expect(parseJsonObject("{bad json")).toBeUndefined();
	});

	it("supports nullable prefixed joined profile rows", () => {
		expect(
			nullableProfileFromDbRow({ participant_id: null }, "participant_"),
		).toBeNull();
		expect(
			nullableProfileFromDbRow(
				{
					participant_id: "profile_2",
					participant_handle: "bob",
					participant_display_name: "Bob",
					participant_bio: null,
					participant_followers_count: 5,
					participant_following_count: 7,
					participant_avatar_hue: 12,
					participant_entities_json: "{}",
					participant_created_at: "2026-02-01T00:00:00.000Z",
				},
				"participant_",
			),
		).toEqual({
			id: "profile_2",
			handle: "bob",
			displayName: "Bob",
			bio: "",
			followersCount: 5,
			followingCount: 7,
			avatarHue: 12,
			entities: {},
			createdAt: "2026-02-01T00:00:00.000Z",
		});
	});

	it("separates display normalization from comparison keys", () => {
		expect(normalizeProfileHandle("  @MixedCase ")).toBe("MixedCase");
		expect(profileHandleKey("  @MixedCase ")).toBe("mixedcase");
	});
});
