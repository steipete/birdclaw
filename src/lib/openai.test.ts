// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	scoreInboxItemWithOpenAI,
	scoreInboxItemWithOpenAIEffect,
} from "./openai";

beforeEach(() => {
	process.env.OPENAI_API_KEY = "";
});

afterEach(() => {
	process.env.OPENAI_API_KEY = "";
	delete process.env.BIRDCLAW_OPENAI_MODEL;
	delete process.env.BIRDCLAW_OPENAI_BASE_URL;
	delete process.env.OPENAI_BASE_URL;
	vi.unstubAllGlobals();
});

describe("openai inbox scoring", () => {
	it("fails without an API key", async () => {
		await expect(
			scoreInboxItemWithOpenAI({
				entityKind: "dm",
				title: "DM",
				text: "hello",
				influenceScore: 90,
				participant: {
					handle: "sam",
					displayName: "Sam",
					bio: "bio",
					followersCount: 10,
				},
			}),
		).rejects.toThrow("OPENAI_API_KEY");
	});

	it("returns clamped structured scores", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		process.env.BIRDCLAW_OPENAI_MODEL = "gpt-test";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										score: 101.6,
										summary: "Strong ask",
										reasoning: "Concrete and relevant",
									}),
								},
							},
						],
					}),
				),
			),
		);

		const result = await scoreInboxItemWithOpenAI({
			entityKind: "mention",
			title: "Mention",
			text: "question?",
			influenceScore: 80,
			participant: {
				handle: "amelia",
				displayName: "Amelia",
				bio: "bio",
				followersCount: 4200,
			},
		});

		expect(result).toEqual({
			model: "gpt-test",
			score: 100,
			summary: "Strong ask",
			reasoning: "Concrete and relevant",
		});
	});

	it("posts inbox scoring requests to an OpenAI-compatible gateway", async () => {
		process.env.OPENAI_API_KEY = "";
		process.env.BIRDCLAW_OPENAI_BASE_URL = "http://localhost:4000/v1";
		process.env.BIRDCLAW_OPENAI_MODEL = "local-model";
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									score: 12,
									summary: "Low signal",
									reasoning: "Generic note",
								}),
							},
						},
					],
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await scoreInboxItemWithOpenAI({
			entityKind: "dm",
			title: "DM",
			text: "hello",
			influenceScore: 10,
			participant: {
				handle: "sam",
				displayName: "Sam",
				bio: "bio",
				followersCount: 10,
			},
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:4000/v1/chat/completions",
			expect.objectContaining({
				headers: { "content-type": "application/json" },
			}),
		);
	});

	it("exposes inbox scoring as an Effect program", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										score: 44,
										summary: "Useful",
										reasoning: "Looks specific",
									}),
								},
							},
						],
					}),
				),
			),
		);

		await expect(
			Effect.runPromise(
				scoreInboxItemWithOpenAIEffect({
					entityKind: "mention",
					title: "Mention",
					text: "question?",
					influenceScore: 80,
					participant: {
						handle: "amelia",
						displayName: "Amelia",
						bio: "bio",
						followersCount: 4200,
					},
				}),
			),
		).resolves.toMatchObject({
			score: 44,
			summary: "Useful",
			reasoning: "Looks specific",
		});
	});

	it("fails when the API returns no content", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ choices: [{ message: {} }] })),
				),
		);

		await expect(
			scoreInboxItemWithOpenAI({
				entityKind: "dm",
				title: "DM",
				text: "hello",
				influenceScore: 90,
				participant: {
					handle: "sam",
					displayName: "Sam",
					bio: "bio",
					followersCount: 10,
				},
			}),
		).rejects.toThrow("no content");
	});
});
