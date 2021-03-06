import { ARGUMENT_SEPARATOR, ExpectedArgumentSeparatorError } from "../command";
import type { CommandContext, ParseEntryPoint } from '../command';
import { UserDisplayableError } from "../error";
import StringReader, { Type } from "../reader";
import type { Suggestions, SuggestionsBuilder } from "../suggestions";
import { ArgumentType } from "./core";
import { BadSeparatorError, FailType, RangeError } from './error';

export type ListParsingStrategy<P, V> = {
	/**
	 * If defined, removes duplicate values after parse
	 * based on stringified version of value
	 */
	uniqueParsedToString?: (value: P) => string,
	/**
	 * If defined, removes duplicate values after load
	 * based on stringified version of value
	 */
	uniqueLoadedToString?: (value: V) => string,
} & {
	type: 'withSeparator',
	// "," by default
	separator?: string,
};

export class ListArgumentType<P, V> extends ArgumentType<P[], V[]> {
	constructor(public strategy: ListParsingStrategy<P, V>, public singleArgumentType: ArgumentType<P, V>, public minimum: number = 1, public maximum: number = Infinity) {
		super();
		if (minimum < 1) throw new Error('minimum should be >= 1');
		if (maximum < minimum) throw new Error('maximum should be >= minimum');
	}
	async listSuggestions<P, S>(entry: ParseEntryPoint<P>, ctx: CommandContext<S, any, any>, builder: SuggestionsBuilder): Promise<Suggestions> {
		return this.singleArgumentType.listSuggestions(entry, ctx, builder);
	}

	get examples(): string[] {
		return this.singleArgumentType.examples;
	}

	parse<S>(ctx: ParseEntryPoint<S>, reader: StringReader): P[] {
		let got: P[] = [];
		if (this.strategy.type === 'withSeparator') {
			const separator = this.strategy.separator ?? ',';
			while (reader.canReadAnything) {
				const gotValue = new StringReader(reader.readBeforeTestFails(t => t !== separator && t !== ' '));
				let value;
				try {
					value = this.singleArgumentType.parse(ctx, gotValue);
				} catch (e) {
					if (e instanceof UserDisplayableError) {
						if (e.reader) {
							if (!e.shouldRewindReader) {
								const cursor = e.reader.cursor;
								reader.cursor += cursor;
							}
							e.reader = reader.clone();
						}
					}
					throw e;
				}
				if (gotValue.cursor !== gotValue.string.length)
					throw new BadSeparatorError(gotValue, separator);
				got.push(value);
				if (reader.canReadAnything) {
					if (reader.peek() === separator) {
						reader.skip();
					} else {
						break;
					}
					if (!reader.canReadAnything)
						throw new ExpectedArgumentSeparatorError(reader);
					if (reader.peek() === ARGUMENT_SEPARATOR)
						reader.skip();
				}
			}
		} else {
			throw new Error('Not handled');
		}
		if (got.length < this.minimum || got.length > this.maximum) {
			throw new RangeError(reader, got.length < this.minimum ? FailType.TOO_LOW : FailType.TOO_HIGH, Type.AMOUNT, got.length, this.minimum, this.maximum);
		}
		if (this.strategy.uniqueParsedToString) {
			const stringSet = new Set();
			got = got.filter(p => {
				const stringified = this.strategy.uniqueParsedToString!(p);
				if (stringSet.has(stringified)) return false;
				stringSet.add(stringified);
				return true;
			});
		}
		return got;
	}

	async load(parsed: P[]): Promise<V[]> {
		let loaded = await Promise.all(parsed.map(p => this.singleArgumentType.load(p)));
		if (this.strategy.uniqueLoadedToString) {
			const stringSet = new Set();
			loaded = loaded.filter(p => {
				const stringified = this.strategy.uniqueLoadedToString!(p);
				if (stringSet.has(stringified)) return false;
				stringSet.add(stringified);
				return true;
			});
		}
		return loaded;
	}
}
