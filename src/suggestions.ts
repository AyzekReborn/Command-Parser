import type { CommandContext } from "./command";
import StringRange from "./range";
import type { CommandNode } from './tree';
import type { MaybePromise } from './util/promise';

export class SuggestionContext<S> {
	constructor(public readonly parent: CommandNode<S, any, any>, public readonly startPos: number) { }
}

export type SuggestionMetadata = {
	prefix?: string,
	suffix?: string,
	order?: number,
	suggestionType?: 'literal' | 'argument',
	commandNode?: CommandNode<any, any, any>,
}

export class Suggestion {
	public prefix?: string;
	public suffix?: string;
	public order: number = 0;

	constructor(public readonly range: StringRange, public metadata: SuggestionMetadata, public readonly text: string, public readonly tooltip: string | null) { }

	apply(input: string) {
		if (this.range.start === 0 && this.range.end === input.length)
			return input
		let result = '';
		if (this.range.start > 0)
			result += input.substring(0, this.range.start);
		result += this.text;
		if (this.range.end < input.length)
			result += input.substring(this.range.end);
		return result;
	}

	expand(command: string, range: StringRange) {
		if (range.equals(this.range))
			return this;
		let result = '';
		if (range.start < this.range.start)
			result += command.substring(range.start, this.range.start);
		result += this.text;
		if (range.end > this.range.end)
			result += command.substring(this.range.end, range.end);
		return new Suggestion(range, this.metadata, result, this.tooltip);
	}
}

const suggestionComparator = undefined;

export class Suggestions {
	constructor(public readonly range: StringRange, public readonly suggestions: Suggestion[]) {

	}

	get isEmpty() {
		return this.suggestions.length === 0;
	}

	static get empty(): Suggestions {
		return EMPTY_SUGGESTIONS;
	}

	static merge(command: string, input: Suggestions[]): Suggestions {
		if (input.length === 0) return EMPTY_SUGGESTIONS;
		if (input.length === 1) return input[0];
		let texts = new Set<Suggestion>();
		for (let suggestions of input) {
			for (let suggestion of suggestions.suggestions) {
				texts.add(suggestion);
			}
		}
		return Suggestions.create(command, Array.from(texts));
	}

	static create(command: string, suggestions: Suggestion[]) {
		if (suggestions.length === 0)
			return EMPTY_SUGGESTIONS;
		let start = Infinity;
		let end = -Infinity;
		for (let suggestion of suggestions) {
			start = Math.min(suggestion.range.start, start);
			end = Math.max(suggestion.range.end, end);
		}
		let range = new StringRange(start, end);
		let texts = new Set<Suggestion>();
		for (let suggestion of suggestions) {
			texts.add(suggestion.expand(command, range));
		}
		let sorted = Array.from(texts);
		sorted.sort(suggestionComparator);
		return new Suggestions(range, sorted);
	}
}
const EMPTY_SUGGESTIONS = new Suggestions(StringRange.at(0), []);

export class SuggestionsBuilder {
	readonly remaining: string;
	readonly result: Suggestion[] = [];
	constructor(public readonly input: string, public readonly start: number, public metadata: SuggestionMetadata) {
		this.remaining = input.substring(start);
	}

	build() {
		return Suggestions.create(this.input, this.result);
	}

	suggest(text: string, tooltip: string | null = null): this {
		if (text === this.remaining) {
			return this;
		}
		this.result.push(new Suggestion(StringRange.between(this.start, this.input.length), this.metadata, text, tooltip));
		return this;
	}

	add(other: SuggestionsBuilder) {
		this.result.push(...other.result);
		return this;
	}

	createOffset(start: number) {
		return new SuggestionsBuilder(this.input, start, this.metadata);
	}

	restart() {
		return new SuggestionsBuilder(this.input, this.start, this.metadata);
	}
}

export type SuggestionProvider<S> = (ctx: CommandContext<S, any, any>, builder: SuggestionsBuilder) => MaybePromise<Suggestions>;
