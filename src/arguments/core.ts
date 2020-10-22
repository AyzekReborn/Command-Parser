import type { CommandContext, ParseEntryPoint } from "../command";
import type StringReader from "../reader";
import type { Suggestions, SuggestionsBuilder } from "../suggestions";
import type { MaybePromise } from "../util/promise";

export abstract class ArgumentType<P, T> {
	/**
	 * Parses data from reader, should not perform any caching/data loading
	 * @param ctx parsing context
	 * @param reader command reader
	 */
	abstract parse<S>(ctx: ParseEntryPoint<S>, reader: StringReader): P;
	/**
	 * Loads parsed data
	 * @param parsed parsed data
	 */
	abstract load(parsed: P): MaybePromise<T>;

	/**
	 * Fill suggestion builder with actual possible completions
	 * by default suggests all examples
	 * @param ctx parsing context
	 * @param builder
	 */
	async listSuggestions<P, S>(entry: ParseEntryPoint<P>, _ctx: CommandContext<S, any, any>, builder: SuggestionsBuilder): Promise<Suggestions> {
		const remaining = builder.remaining;
		for (const literal of this.getExamples(entry))
			if (literal.startsWith(remaining))
				builder.suggest(literal);
		return builder.build();
	}

	getExamples<P>(_entry: ParseEntryPoint<P>): string[] {
		return this.examples;
	}

	/**
	 * Argument examples, used by default for listSuggestions and
	 * for conflict search
	 */
	get examples(): string[] {
		return [];
	}

}

export abstract class SimpleArgumentType<T> extends ArgumentType<T, T>{
	load(parsed: T): T {
		return parsed;
	}
}
