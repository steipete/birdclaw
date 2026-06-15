import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __test__, useAvatarPreload } from "./AvatarPreload";

class MockImage {
	static instances: MockImage[] = [];

	decoding = "auto";
	onerror: ((event: Event) => void) | null = null;
	onload: ((event: Event) => void) | null = null;
	src = "";

	constructor() {
		MockImage.instances.push(this);
	}

	decode() {
		return Promise.resolve();
	}
}

function setReadyState(value: DocumentReadyState) {
	Object.defineProperty(document, "readyState", {
		configurable: true,
		value,
	});
}

function installBrowserMocks() {
	const idleCallbacks: IdleRequestCallback[] = [];
	vi.stubGlobal("Image", MockImage);
	vi.stubGlobal(
		"requestIdleCallback",
		vi.fn((callback: IdleRequestCallback) => {
			idleCallbacks.push(callback);
			return idleCallbacks.length;
		}),
	);
	vi.stubGlobal("cancelIdleCallback", vi.fn());
	return idleCallbacks;
}

function installIntersectionObserverMock() {
	const callbacks: IntersectionObserverCallback[] = [];
	const disconnect = vi.fn();
	const observe = vi.fn();
	class MockIntersectionObserver {
		constructor(callback: IntersectionObserverCallback) {
			callbacks.push(callback);
		}

		disconnect = disconnect;
		observe = observe;
	}
	vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
	return { callbacks, disconnect, observe };
}

function runIdle(callback: IdleRequestCallback | undefined) {
	if (!callback) throw new Error("Missing idle callback");
	callback({ didTimeout: false, timeRemaining: () => 50 });
}

afterEach(() => {
	__test__.resetPreloader();
	MockImage.instances = [];
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, "readyState");
});

describe("avatar preloading", () => {
	it("waits for the page load and an idle turn", () => {
		setReadyState("loading");
		const idleCallbacks = installBrowserMocks();

		__test__.queueAvatarPreload(
			"profile_sam",
			"https://pbs.twimg.com/profile_images/123/avatar.jpg",
		);
		expect(idleCallbacks).toHaveLength(0);
		expect(MockImage.instances).toHaveLength(0);

		window.dispatchEvent(new Event("load"));
		expect(idleCallbacks).toHaveLength(1);
		expect(MockImage.instances).toHaveLength(0);

		runIdle(idleCallbacks.shift());
		expect(MockImage.instances).toHaveLength(1);
		expect(MockImage.instances[0]).toMatchObject({
			decoding: "async",
			src: "/api/avatar?profileId=profile_sam&v=https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2F123%2Favatar.jpg",
		});
	});

	it("deduplicates matching hover avatars", () => {
		setReadyState("complete");
		const idleCallbacks = installBrowserMocks();
		const avatarUrl = "https://pbs.twimg.com/profile_images/123/avatar.jpg";

		__test__.queueAvatarPreload("profile_sam", avatarUrl);
		__test__.queueAvatarPreload("profile_sam", avatarUrl);
		runIdle(idleCallbacks.shift());

		expect(MockImage.instances).toHaveLength(1);
	});

	it("waits until a hover trigger is near the viewport", () => {
		setReadyState("complete");
		const idleCallbacks = installBrowserMocks();
		const intersection = installIntersectionObserverMock();
		const node = document.createElement("span");

		renderHook(() =>
			useAvatarPreload(
				{ current: node },
				"profile_sam",
				"https://pbs.twimg.com/profile_images/123/avatar.jpg",
			),
		);

		expect(intersection.observe).toHaveBeenCalledWith(node);
		expect(idleCallbacks).toHaveLength(0);
		const observer = {
			disconnect: intersection.disconnect,
		} as unknown as IntersectionObserver;
		intersection.callbacks[0]?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			observer,
		);
		expect(intersection.disconnect).toHaveBeenCalled();
		expect(idleCallbacks).toHaveLength(1);

		runIdle(idleCallbacks.shift());
		expect(MockImage.instances).toHaveLength(1);
	});

	it("limits concurrent preloads and continues as images decode", async () => {
		setReadyState("complete");
		const idleCallbacks = installBrowserMocks();

		for (let index = 0; index < 5; index += 1) {
			__test__.queueAvatarPreload(
				`profile_${String(index)}`,
				`https://pbs.twimg.com/profile_images/${String(index)}/avatar.jpg`,
			);
		}
		runIdle(idleCallbacks.shift());
		expect(MockImage.instances).toHaveLength(4);

		MockImage.instances[0]?.onload?.(new Event("load"));
		await Promise.resolve();
		await Promise.resolve();

		expect(MockImage.instances).toHaveLength(5);
	});
});
