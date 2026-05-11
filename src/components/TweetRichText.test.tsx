import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TweetRichText } from "./TweetRichText";

describe("TweetRichText", () => {
	it("renders mentions, urls, and hashtags with rich spans", () => {
		render(
			<TweetRichText
				text="@amelia ship https://t.co/demo #birdclaw"
				entities={{
					mentions: [
						{
							username: "amelia",
							id: "profile_amelia",
							start: 0,
							end: 7,
							profile: {
								id: "profile_amelia",
								handle: "amelia",
								displayName: "Amelia N",
								bio: "Design systems",
								followersCount: 4200,
								avatarHue: 320,
								createdAt: "2026-03-08T12:00:00.000Z",
							},
						},
					],
					urls: [
						{
							url: "https://t.co/demo",
							expandedUrl: "https://example.com/demo",
							displayUrl: "example.com/demo",
							start: 13,
							end: 30,
						},
					],
					hashtags: [
						{
							tag: "birdclaw",
							start: 31,
							end: 40,
						},
					],
				}}
			/>,
		);

		expect(screen.getAllByText("@amelia")[0]).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "example.com/demo" }),
		).toHaveAttribute("href", "https://example.com/demo");
		expect(screen.getByText("#birdclaw")).toBeInTheDocument();
		expect(screen.getByText("Design systems")).toBeInTheDocument();
	});

	it("links raw urls when archive entities are missing", () => {
		render(<TweetRichText text="Check it: https://t.co/raw" entities={{}} />);

		expect(screen.getByRole("link", { name: "t.co/raw" })).toHaveAttribute(
			"href",
			"https://t.co/raw",
		);
	});
});
