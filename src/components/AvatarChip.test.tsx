import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarChip } from "./AvatarChip";

afterEach(() => {
	cleanup();
});

describe("AvatarChip", () => {
	it("renders initials, hue, and large variant", () => {
		render(<AvatarChip hue={210} name="Sam Altman" size="large" />);

		const chip = screen.getByText("SA");
		expect(chip).toHaveClass("avatar-chip-large");
		expect(chip).toHaveStyle({ backgroundColor: "rgb(36, 128, 219)" });
	});

	it("renders cached avatar image when profile metadata exists", () => {
		render(
			<AvatarChip
				avatarUrl="https://pbs.twimg.com/profile_images/123/avatar.jpg"
				hue={210}
				name="Sam Altman"
				profileId="profile_sam"
			/>,
		);

		const image = screen.getByRole("img", { name: "Sam Altman" });
		expect(image).toHaveAttribute(
			"src",
			expect.stringContaining("/api/avatar?profileId=profile_sam&v="),
		);
	});

	it("tries the stored Twitter image once before falling back to initials", () => {
		render(
			<AvatarChip
				avatarUrl="https://pbs.twimg.com/profile_images/123/avatar.jpg"
				hue={210}
				name="Sam Altman"
				profileId="profile_sam"
			/>,
		);

		const image = screen.getByRole("img", { name: "Sam Altman" });
		fireEvent.error(image);
		const fallback = screen.getByRole("img", { name: "Sam Altman" });
		expect(fallback).toHaveAttribute(
			"src",
			"https://pbs.twimg.com/profile_images/123/avatar.jpg",
		);
		expect(fallback).toHaveAttribute("referrerpolicy", "no-referrer");
		fireEvent.error(fallback);

		expect(screen.getByText("SA")).toBeInTheDocument();
	});
});

it.each([
	"https://other.example/avatar.jpg",
	"http://pbs.twimg.com/profile_images/a.jpg",
	"https://pbs.twimg.com/media/a.jpg",
	"https://user:pass@pbs.twimg.com/profile_images/a.jpg",
	"https://pbs.twimg.com:8443/profile_images/a.jpg",
	"data:image/svg+xml,<svg/>",
])("never falls back to an untrusted avatar URL: %s", (avatarUrl) => {
	render(
		<AvatarChip
			profileId="profile_sam"
			avatarUrl={avatarUrl}
			name="Sam Altman"
			hue={210}
		/>,
	);
	fireEvent.error(screen.getByRole("img"));
	expect(screen.queryByRole("img")).toBeNull();
});

it("retries the cache when the profile changes after both attempts fail", () => {
	const avatarUrl = "https://pbs.twimg.com/profile_images/a.jpg";
	const { rerender } = render(
		<AvatarChip
			profileId="old"
			avatarUrl={avatarUrl}
			name="Sam Altman"
			hue={210}
		/>,
	);
	fireEvent.error(screen.getByRole("img"));
	fireEvent.error(screen.getByRole("img"));
	rerender(
		<AvatarChip
			profileId="new"
			avatarUrl={avatarUrl}
			name="Sam Altman"
			hue={210}
		/>,
	);
	expect(screen.getByRole("img")).toHaveAttribute(
		"src",
		expect.stringContaining("profileId=new"),
	);
});

it("renders a trusted avatar without a local profile ID", () => {
	render(
		<AvatarChip
			avatarUrl="https://pbs.twimg.com/profile_images/a.jpg"
			name="Sam Altman"
			hue={210}
		/>,
	);
	expect(screen.getByRole("img")).toHaveAttribute(
		"src",
		"https://pbs.twimg.com/profile_images/a.jpg",
	);
	fireEvent.error(screen.getByRole("img"));
	expect(screen.queryByRole("img")).toBeNull();
});
