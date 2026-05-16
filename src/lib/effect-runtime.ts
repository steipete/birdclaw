import { Cause, Effect, Exit, Option } from "effect";

export function tryPromise<A>(
	try_: () => PromiseLike<A>,
): Effect.Effect<A, unknown> {
	return Effect.tryPromise({
		try: try_,
		catch: (cause) => cause,
	});
}

export function runEffectPromise<A, E>(
	effect: Effect.Effect<A, E>,
): Promise<A> {
	return Effect.runPromiseExit(effect).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure)) throw failure.value;
		throw Cause.squash(exit.cause);
	});
}
