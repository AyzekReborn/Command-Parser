import type { CommandContext, ParseEntryPoint } from "../command";
import type StringReader from "../reader";
import type { Suggestions, SuggestionsBuilder } from "../suggestions";
import { SimpleArgumentType } from "./core";
import type { ArgumentType } from './core';

/**
 * Skips load method of wrapped argument
 */
export class AsSimpleArgumentType<T> extends SimpleArgumentType<T> {
	constructor(public wrapped: ArgumentType<T, any>) {
		super();
	}
	parse<P>(ctx: ParseEntryPoint<P>, reader: StringReader): T {
		return this.wrapped.parse(ctx, reader);
	}

	listSuggestions<P, S>(entry: ParseEntryPoint<P>, ctx: CommandContext<S, any, any>, builder: SuggestionsBuilder): Promise<Suggestions> {
		return this.wrapped.listSuggestions(entry, ctx, builder);
	}

	getExamples<P>(ctx: ParseEntryPoint<P>): string[] {
		return this.wrapped.getExamples(ctx);
	}
}
