import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TweetRichText } from "./TweetRichText";

function codePointRange(text: string, needle: string) {
	const start = Array.from(text.slice(0, text.indexOf(needle))).length;
	return { start, end: start + Array.from(needle).length };
}

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

		const mention = screen.getAllByText("@amelia")[0];
		expect(mention).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "example.com/demo" }),
		).toHaveAttribute("href", "https://example.com/demo");
		expect(screen.getByText("#birdclaw")).toBeInTheDocument();
		fireEvent.pointerEnter(
			mention.closest(".profile-preview-trigger")?.parentElement as Element,
		);
		expect(screen.getByText("Design systems")).toBeInTheDocument();
	});

	it("links raw urls when archive entities are missing", () => {
		render(<TweetRichText text="Check it: https://t.co/raw" entities={{}} />);

		expect(screen.getByRole("link", { name: "t.co/raw" })).toHaveAttribute(
			"href",
			"https://t.co/raw",
		);
	});

	it("can show expanded url labels", () => {
		const { container } = render(
			<TweetRichText
				entities={{
					urls: [
						{
							url: "https://t.co/demo",
							expandedUrl: "https://example.com/demo",
							displayUrl: "example.com/demo",
							start: 6,
							end: 23,
						},
					],
				}}
				text="Read: https://t.co/demo"
				urlLabel="expanded"
			/>,
		);

		expect(
			screen.getByRole("link", { name: "https://example.com/demo" }),
		).toHaveAttribute("href", "https://example.com/demo");
		expect(container).not.toHaveTextContent("Read: example.com/demo");
	});

	it("hides shortlinks when Twitter Article metadata is available", () => {
		const { container } = render(
			<TweetRichText
				entities={{
					article: {
						title: "A frontier without an ecosystem is not stable",
						previewText: "The future of the firm.",
						url: "https://x.com/satyanadella/status/2066182223213293753",
					},
				}}
				text="https://t.co/vLmiBKTtX3"
			/>,
		);

		expect(container.firstElementChild).toBeEmptyDOMElement();
		expect(within(container).queryByText(/t\.co/)).toBeNull();
	});

	it("keeps unrelated shortlinks beside a Twitter Article link", () => {
		const text =
			"A frontier without an ecosystem is not stable https://t.co/article https://t.co/other";
		render(
			<TweetRichText
				entities={{
					urls: [
						{
							url: "https://t.co/article",
							expandedUrl: "https://x.com/i/article/2065582894790365184",
							displayUrl: "x.com/i/article/2065…",
							...codePointRange(text, "https://t.co/article"),
						},
						{
							url: "https://t.co/other",
							expandedUrl: "https://example.com/other",
							displayUrl: "example.com/other",
							...codePointRange(text, "https://t.co/other"),
						},
					],
					article: {
						title: "A frontier without an ecosystem is not stable",
						url: "https://x.com/satyanadella/status/2066182223213293753",
					},
				}}
				text={text}
			/>,
		);

		expect(screen.queryByText("x.com/i/article/2065…")).toBeNull();
		expect(
			screen.getByRole("link", { name: "example.com/other" }),
		).toHaveAttribute("href", "https://example.com/other");
	});

	it("links mention entities even without hydrated profile previews", () => {
		render(
			<TweetRichText
				entities={{
					mentions: [{ username: "openclaw", start: 5, end: 14 }],
				}}
				text="Meet @openclaw"
			/>,
		);

		expect(screen.getByRole("link", { name: "@openclaw" })).toHaveAttribute(
			"href",
			"/profiles/openclaw",
		);
	});

	it("renders X API code point ranges after emoji in profile bios", () => {
		const text =
			"Futurist 🦄\nChief Architect @openclaw 🦞\nWriter @forbes Tech Council\nAdjunct @MIT\nEx @Microsoft @Qantas";
		const mention = (username: string) => ({
			username,
			...codePointRange(text, `@${username}`),
		});
		const { container } = render(
			<TweetRichText
				entities={{
					mentions: [
						mention("openclaw"),
						mention("forbes"),
						mention("MIT"),
						mention("Microsoft"),
						mention("Qantas"),
					],
				}}
				text={text}
			/>,
		);

		const rendered = within(container);
		expect(rendered.getByText(/Chief Architect/)).toHaveTextContent(
			"Chief Architect",
		);
		expect(rendered.getByText(/Writer/)).toHaveTextContent("Writer");
		expect(rendered.getByRole("link", { name: "@openclaw" })).toHaveAttribute(
			"href",
			"/profiles/openclaw",
		);
		expect(rendered.getByRole("link", { name: "@forbes" })).toHaveAttribute(
			"href",
			"/profiles/forbes",
		);
		expect(rendered.getByRole("link", { name: "@MIT" })).toHaveAttribute(
			"href",
			"/profiles/MIT",
		);
		expect(rendered.getByRole("link", { name: "@Microsoft" })).toHaveAttribute(
			"href",
			"/profiles/Microsoft",
		);
		expect(rendered.getByRole("link", { name: "@Qantas" })).toHaveAttribute(
			"href",
			"/profiles/Qantas",
		);
	});

	it("hides X API code point URL ranges after emoji", () => {
		const text = "🦞 https://t.co/photo";
		const range = codePointRange(text, "https://t.co/photo");
		const { container } = render(
			<TweetRichText
				entities={{
					urls: [
						{
							url: "https://t.co/photo",
							expandedUrl: "https://x.com/openclaw/status/1/photo/1",
							displayUrl: "pic.x.com/photo",
							...range,
						},
					],
				}}
				hiddenUrlRanges={[range]}
				text={text}
			/>,
		);

		expect(container).toHaveTextContent("🦞");
		expect(screen.queryByRole("link", { name: "pic.x.com/photo" })).toBeNull();
		expect(screen.queryByText(/t\.co\/photo/)).toBeNull();
	});

	it("keeps unsafe url entity text visible as plain text", () => {
		const { container } = render(
			<TweetRichText
				text="Unsafe https://t.co/bad stays"
				entities={{
					urls: [
						{
							url: "https://t.co/bad",
							expandedUrl: "javascript:alert(1)",
							displayUrl: "bad.example",
							start: 7,
							end: 23,
						},
					],
				}}
			/>,
		);

		expect(screen.getByText(/https:\/\/t\.co\/bad/)).toBeInTheDocument();
		expect(container.querySelector("a")).toBeNull();
	});
});
