import { Effect } from "effect";

// Wraps a vi.fn() promise mock as an Effect-returning transport function for
// vi.mock factories. Non-thenable returns (unconfigured mocks) fail the
// effect, matching how Effect.tryPromise treated the old promise wrappers.
export function effectFromMock(mock: (...args: unknown[]) => unknown) {
	return (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => mock(...args) as PromiseLike<unknown>,
			catch: (error) => error,
		});
}
