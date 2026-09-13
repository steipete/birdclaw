import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TweetMediaGrid } from "./TweetMediaGrid";

describe("TweetMediaGrid", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders nothing without media", () => {
		const { container } = render(<TweetMediaGrid items={[]} />);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders images, fallback media labels, and caps the grid at four items", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
						thumbnailUrl: "https://example.com/one-thumb.jpg",
					},
					{
						url: "https://example.com/two.mp4",
						type: "video",
					},
					{
						url: "https://example.com/three.gif",
						type: "gif",
					},
					{
						url: "https://example.com/four.bin",
						type: "unknown",
					},
					{
						url: "https://example.com/five.jpg",
						type: "image",
					},
				]}
			/>,
		);

		expect(container.firstChild).toHaveClass("tweet-media-grid-4");
		expect(screen.getByAltText("Tweet media 1")).toHaveAttribute(
			"src",
			"https://example.com/one-thumb.jpg",
		);
		expect(container.querySelector("video source")).toHaveAttribute(
			"src",
			"https://example.com/two.mp4",
		);
		expect(
			screen.getByText("No playable video in this archive"),
		).toBeInTheDocument();
		expect(screen.getByText("Media")).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: /Open tweet media/ }),
		).toHaveLength(2);
	});

	it("opens images in an inline viewer", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
						width: 1200,
						height: 800,
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Tweet media" })).toHaveAttribute(
			"src",
			"https://example.com/one.jpg",
		);
	});

	it("uses a natural single-image frame instead of the full grid shell", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/tall.jpg",
						type: "image",
						altText: "Tall screenshot",
						width: 768,
						height: 1600,
					},
				]}
			/>,
		);

		expect(container.firstChild).toHaveClass("tweet-media-single");
		expect(container.firstChild).not.toHaveClass("tweet-media-grid");
		expect(screen.getByAltText("Tall screenshot")).toHaveAttribute(
			"width",
			"768",
		);
	});

	it("renders video controls directly in the feed without opening a viewer", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://pbs.twimg.com/video-thumb.jpg",
						type: "video",
						thumbnailUrl: "https://pbs.twimg.com/video-thumb.jpg",
						variants: [
							{
								url: "https://video.twimg.com/clip.mp4",
								contentType: "video/mp4",
							},
						],
					},
				]}
			/>,
		);

		const video = container.querySelector("video");
		expect(video).toHaveAttribute("controls");
		expect(video).toHaveAttribute("playsinline");
		expect(video).toHaveAttribute("preload", "none");
		expect(video).not.toHaveAttribute("autoplay");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(video?.closest("button")).toBeNull();
		expect(video?.querySelector("source")).toHaveAttribute(
			"src",
			"https://video.twimg.com/clip.mp4",
		);
		expect(video).toHaveAttribute(
			"poster",
			"https://pbs.twimg.com/video-thumb.jpg",
		);
	});

	it("opens direct video CDN URLs inline without a variant", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://video.twimg.com/ext_tw_video/clip.mp4",
						type: "video",
					},
				]}
			/>,
		);

		expect(container.querySelector("video source")).toHaveAttribute(
			"src",
			"https://video.twimg.com/ext_tw_video/clip.mp4",
		);
	});

	it("opens gif mp4 fallbacks inline as looping muted video", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "/media/demo.mp4",
						type: "gif",
					},
				]}
			/>,
		);

		const video = container.querySelector("video");
		expect(video?.querySelector("source")).toHaveAttribute(
			"src",
			"/media/demo.mp4",
		);
		expect(video).toHaveAttribute("loop");
		expect(video?.muted).toBe(true);
	});

	it("does not treat variant-less video thumbnails as playable video", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						url: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
						type: "video",
						thumbnailUrl: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
					},
				]}
			/>,
		);

		expect(container.querySelector("video")).toBeNull();
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"href",
			"https://pbs.twimg.com/ext_tw_video_thumb/video.jpg",
		);
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"target",
			"_blank",
		);
	});

	it("chooses the highest-bitrate MP4 over HLS and unsafe variants", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						type: "video",
						url: "https://pbs.twimg.com/poster.jpg",
						variants: [
							{
								url: "https://video.twimg.com/clip.m3u8",
								contentType: "application/x-mpegURL",
							},
							{
								url: "https://video.twimg.com/low.mp4",
								contentType: "video/mp4",
								bitRate: 100,
							},
							{
								url: "javascript:alert(1)",
								contentType: "video/mp4",
								bitRate: 99999,
							},
							{
								url: "https://video.twimg.com/high.mp4",
								contentType: "video/mp4",
								bitRate: 1000,
							},
						],
					},
				]}
			/>,
		);
		expect(container.querySelector("video source")).toHaveAttribute(
			"src",
			"https://video.twimg.com/high.mp4",
		);
	});

	it("keeps playback clicks inside the media and links failed playback to the original tweet", () => {
		const onClick = vi.fn();
		const { container } = render(
			<div onClick={onClick}>
				<TweetMediaGrid
					tweetId="123"
					items={[{ type: "video", url: "/clip.mp4" }]}
				/>
			</div>,
		);
		const video = container.querySelector("video")!;
		fireEvent.click(video);
		expect(onClick).not.toHaveBeenCalled();
		fireEvent.error(video);
		expect(container.querySelector("video")).toBeNull();
		expect(screen.getByRole("link", { name: "Watch on X" })).toHaveAttribute(
			"href",
			"https://x.com/i/status/123",
		);
		expect(screen.getByText("Video unavailable")).toBeInTheDocument();
	});

	it("keeps alternate sources available until the last source fails", () => {
		const { container } = render(
			<TweetMediaGrid
				tweetId="123"
				items={[
					{
						type: "video",
						url: "/poster.png",
						variants: [
							{ url: "/primary.mp4", contentType: "video/mp4", bitRate: 1000 },
							{
								url: "/alternate.webm",
								contentType: "video/webm",
								bitRate: 500,
							},
						],
					},
				]}
			/>,
		);
		const sources = container.querySelectorAll("source");
		expect(sources).toHaveLength(2);
		fireEvent.error(sources[0]);
		expect(container.querySelector("video")).not.toBeNull();
		fireEvent.error(sources[1]);
		expect(container.querySelector("video")).toBeNull();
		expect(
			screen.getByRole("link", { name: "Watch on X" }),
		).toBeInTheDocument();
	});

	it("retains HLS-only variants for browsers with native HLS playback", () => {
		const { container } = render(
			<TweetMediaGrid
				items={[
					{
						type: "video",
						url: "https://pbs.twimg.com/poster.jpg",
						variants: [
							{
								url: "https://video.twimg.com/clip.m3u8",
								contentType: "application/x-mpegURL",
							},
						],
					},
				]}
			/>,
		);
		expect(container.querySelector("video source")).toHaveAttribute(
			"src",
			"https://video.twimg.com/clip.m3u8",
		);
	});

	it("closes the inline viewer from the close button", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/one.jpg",
						type: "image",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Close media viewer" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("keeps a fallback open path for unknown media", () => {
		render(
			<TweetMediaGrid
				items={[
					{
						url: "https://example.com/archive-media.bin",
						type: "unknown",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tweet media 1" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"href",
			"https://example.com/archive-media.bin",
		);
		expect(screen.getByRole("link", { name: "Open media" })).toHaveAttribute(
			"rel",
			"noreferrer",
		);
	});
});
