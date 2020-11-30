import { ArgumentType } from "./arguments";
import CommandContextBuilder, { Command, CommandContext, CurrentArguments, ParseEntryPoint, RedirectModifier } from "./command";
import { CommandSyntaxError } from "./error";
import StringRange from "./range";
import StringReader from "./reader";
import { NormalizedRequirement, RequirementFailure } from "./requirement";
import { SuggestionProvider, Suggestions, SuggestionsBuilder } from "./suggestions";
import { MaybePromise } from './util/promise';

export type AmbiguityConsumer<Source> = (parent: CommandNode<Source, any, any>, child: CommandNode<Source, any, any>, sibling: CommandNode<Source, any, any>, inputs: Set<string>) => void;
export abstract class CommandNode<Source, ArgumentTypeMap extends CurrentArguments, ReturnValue> {
	childrenMap: Map<string, CommandNode<Source, ArgumentTypeMap, ReturnValue>> = new Map();
	literals: Map<string, LiteralCommandNode<Source, ArgumentTypeMap, ReturnValue>> = new Map();
	arguments: Map<string, ArgumentCommandNode<any, Source, unknown, unknown, ArgumentTypeMap, ReturnValue>> = new Map();
	constructor(
		public command?: Command<Source, ArgumentTypeMap, ReturnValue>,
		public commandDescription?: string,
		public readonly requirement?: NormalizedRequirement<Source, ReturnValue>,
		public readonly redirect?: CommandNode<Source, ArgumentTypeMap, ReturnValue>,
		public readonly modifier?: RedirectModifier<Source, ArgumentTypeMap, ReturnValue>,
	) { }
	get children() { return Array.from(this.childrenMap.values()); }
	getChild(name: string) {
		return this.childrenMap.get(name);
	}
	checkRequirement(source: Source): RequirementFailure<ReturnValue> | undefined {
		if (this.requirement) {
			let failure = this.requirement(source);
			if (failure) {
				return failure;
			}
		}
		if (this.command) {
			return;
		}
		if (this.redirect) {
			let failure = this.redirect.checkRequirement(source);
			if (!failure) {
				return;
			}
		}
		for (let child of this.children) {
			let failure = child.checkRequirement(source);
			if (!failure)
				return;
		}
	}
	removeChild(node: CommandNode<Source, ArgumentTypeMap, ReturnValue>) {
		this.childrenMap.delete(node.name);
		if (node instanceof LiteralCommandNode) {
			this.literals.delete(node.name);
		} else if (node instanceof ArgumentCommandNode) {
			this.arguments.delete(node.name);
		}
	}
	addChild(node: CommandNode<Source, ArgumentTypeMap, ReturnValue>) {
		if (node instanceof RootCommandNode) throw new Error('Cannot add RootCommandNode as child');
		let child = this.getChild(node.name);
		if (child) {
			if (node.command) {
				child.command = node.command;
			}
			for (let grandchild of node.children) {
				child.addChild(grandchild);
			}
		} else {
			this.childrenMap.set(node.name, node);
			if (node instanceof LiteralCommandNode) {
				this.literals.set(node.name, node);
			} else if (node instanceof ArgumentCommandNode) {
				this.arguments.set(node.name, node);
			}
		}
		this.childrenMap = new Map(Array.from(this.childrenMap.entries()).sort((a, b) => a[1].compareTo(b[1])))
	}
	findAmbiguities<P>(ctx: ParseEntryPoint<P>, consumer: AmbiguityConsumer<Source>) {
		let matches = new Set<string>();
		for (let child of this.children) {
			for (let sibling of this.children) {
				if (child === sibling)
					continue;
				for (let input of child.examples) {
					if (sibling.isValidInput(ctx, input)) {
						matches.add(input);
					}
				}
				if (matches.size > 0) {
					consumer(this, child, sibling, matches);
					matches = new Set<string>();
				}
			}
			child.findAmbiguities(ctx, consumer);
		}
	}
	abstract isValidInput<P>(ctx: ParseEntryPoint<P>, input: string): MaybePromise<boolean>;

	abstract get name(): string;
	abstract get usage(): string;
	abstract parse<P>(ctx: ParseEntryPoint<P>, reader: StringReader, contextBuilder: CommandContextBuilder<Source, ArgumentTypeMap, ReturnValue>): MaybePromise<void>;
	abstract async listSuggestions<P>(entry: ParseEntryPoint<P>, context: CommandContext<Source, ArgumentTypeMap, ReturnValue>, builder: SuggestionsBuilder): Promise<Suggestions>;

	abstract get sortedKey(): string;

	/**
	 * Get possible next arguments
	 * @param input
	 */
	getRelevant(input: StringReader): Array<CommandNode<Source, ArgumentTypeMap, ReturnValue>> {
		if (this.literals.size > 0) {
			let cursor = input.cursor;
			while (input.canReadAnything && input.peek() !== ' ')
				input.skip();
			let text = input.string.substring(cursor, input.cursor);
			input.cursor = cursor;
			let literal = [...this.literals.values()].filter(l => l.isMe(text))[0];
			if (literal) {
				return [literal];
			} else {
				return Array.from(this.arguments.values());
			}
		} else {
			return Array.from(this.arguments.values());
		}
	}

	compareTo(other: CommandNode<Source, ArgumentTypeMap, ReturnValue>): number {
		if (this instanceof LiteralCommandNode === other instanceof LiteralCommandNode) {
			return this.sortedKey.localeCompare(other.sortedKey);
		} else {
			return (other instanceof LiteralCommandNode) ? 1 : -1;
		}
	}

	abstract get examples(): string[];
}

export class LiteralError extends CommandSyntaxError {
	constructor(public reader: StringReader, public literal: string) {
		super(reader, `Unknown literal at ${reader}: ${literal}`);
		this.name = 'LiteralError';
	}
}

export class PassthroughCommandNode<S, O extends CurrentArguments, ReturnValue> extends CommandNode<S, O, ReturnValue> {
	constructor(public inner: CommandNode<S, O, ReturnValue>) {
		super(inner.command, inner.commandDescription, inner.requirement, inner.redirect, inner.modifier);
	}

	isValidInput<P>(ctx: ParseEntryPoint<P>, input: string): MaybePromise<boolean> {
		return this.inner.isValidInput(ctx, input);
	}
	get name(): string {
		return this.inner.name;
	}
	get usage(): string {
		return this.inner.usage;
	}
	parse<P>(_ctx: ParseEntryPoint<P>, _reader: StringReader, _contextBuilder: CommandContextBuilder<S, O, ReturnValue>): MaybePromise<void> {
		return;
	}
	listSuggestions<P>(entry: ParseEntryPoint<P>, context: CommandContext<S, O, ReturnValue>, builder: SuggestionsBuilder): Promise<Suggestions> {
		return this.inner.listSuggestions(entry, context, builder);
	}
	get sortedKey(): string {
		return this.inner.sortedKey;
	}
	get examples(): string[] {
		return this.inner.examples;
	}
}

export class LiteralCommandNode<S, O extends CurrentArguments, ReturnValue> extends CommandNode<S, O, ReturnValue> {
	constructor(
		public readonly literalNames: string[],
		command?: Command<S, O, ReturnValue>,
		commandDescription?: string,
		requirement?: NormalizedRequirement<S, ReturnValue>,
		redirect?: CommandNode<S, O, ReturnValue>,
		modifier?: RedirectModifier<S, O, ReturnValue>,
	) {
		super(command, commandDescription, requirement, redirect, modifier);
	}

	get name(): string {
		return this.literal;
	}

	get literal(): string {
		return this.literalNames[0];
	}

	get aliases(): string[] {
		return this.literalNames.slice(1);
	}

	isMe(name: string) {
		return this.literalNames.includes(name.toLowerCase());
	}

	parse<P>(_ctx: ParseEntryPoint<P>, reader: StringReader, contextBuilder: CommandContextBuilder<S, O, ReturnValue>) {
		let start = reader.cursor;
		let end = this._parse(reader);
		if (end > -1) {
			contextBuilder.withNode(this, StringRange.between(start, end));
			return;
		}
		throw new LiteralError(reader, this.name);
	}

	private _parse(reader: StringReader) {
		let start = reader.cursor;
		for (const literal of this.literalNames) {
			if (reader.canRead(literal.length)) {
				let end = start + literal.length;
				if (reader.string.substring(start, end).toLowerCase() === literal) {
					reader.cursor = end;
					if (!reader.canReadAnything || reader.peek() === ' ') {
						return end;
					} else {
						reader.cursor = start;
					}
				}
			}
		}
		return -1;
	}

	async listSuggestions<P>(_entry: ParseEntryPoint<P>, _context: CommandContext<S, O, ReturnValue>, builder: SuggestionsBuilder): Promise<Suggestions> {
		const remaining = builder.remaining.toLowerCase();
		for (const literal of this.literalNames) {
			if (literal.toLowerCase().startsWith(remaining)) {
				const other = this.literalNames.filter(e => e !== literal);
				builder.suggest(literal, other.length === 0 ? undefined : `${other.join(', ')}`);
			}
		}
		return builder.build();
	}

	isValidInput<P>(_ctx: ParseEntryPoint<P>, input: string): boolean {
		return this._parse(new StringReader(input)) > -1;
	}

	get usage() {
		return this.name;
	}

	get sortedKey() {
		return this.name;
	}

	get examples() {
		return [this.name];
	}

	toString() {
		return `<literal ${this.name}>`;
	}
}

export class RootCommandNode<S, ReturnValue> extends CommandNode<S, {}, ReturnValue> {
	constructor() {
		super(undefined, undefined, () => undefined, undefined, (s: CommandContext<S, {}, any>) => s as any);
	}
	get name() {
		return '';
	}
	get usage() {
		return '';
	}
	parse() { };
	async listSuggestions(): Promise<Suggestions> {
		return Suggestions.empty;
	}
	isValidInput() {
		return false;
	}

	get sortedKey() {
		return '';
	}

	get examples(): string[] {
		return [];
	}

	toString() {
		return '<root>';
	}
}

export class ArgumentCommandNode<N extends string, S, P, T, O extends CurrentArguments, ReturnValue> extends CommandNode<S, O, ReturnValue> {
	constructor(
		public readonly name: N,
		public readonly type: ArgumentType<P, T>,
		public readonly customSuggestions?: SuggestionProvider<S>,
		command?: Command<S, O, ReturnValue>,
		commandDescription?: string,
		requirement?: NormalizedRequirement<S, ReturnValue>,
		redirect?: CommandNode<S, O, ReturnValue>,
		modifier?: RedirectModifier<S, O, ReturnValue>,
	) {
		super(command, commandDescription, requirement, redirect, modifier);
	}

	get usage() {
		return `<${this.name}>`;
	}

	async parse<P>(ctx: ParseEntryPoint<P>, reader: StringReader, contextBuilder: CommandContextBuilder<S, O, ReturnValue>) {
		let start = reader.cursor;

		const parsedValue = this.type.parse(ctx, reader);
		let loaded: T = await this.type.load(parsedValue);

		let parsed = {
			range: StringRange.between(start, reader.cursor),
			result: loaded,
			argumentType: this.type,
		};

		contextBuilder.withArgument(this.name, parsed);
		contextBuilder.withNode(this, parsed.range);
	}

	async listSuggestions<P>(entry: ParseEntryPoint<P>, ctx: CommandContext<S, O, ReturnValue>, builder: SuggestionsBuilder): Promise<Suggestions> {
		let got: Suggestions;
		if (this.customSuggestions) {
			got = await this.customSuggestions(ctx, builder);
		} else {
			got = await this.type.listSuggestions(entry, ctx, builder);
		}
		return got;
	}

	async isValidInput<P>(ctx: ParseEntryPoint<P>, input: string) {
		try {
			let reader = new StringReader(input);
			await (this.type as any).parse(ctx, reader);
			return !reader.canReadAnything || reader.peek() == ' ';
		} catch {
			return false;
		}
	}

	get sortedKey() {
		return this.name;
	}

	get examples() {
		return this.type.examples;
	}

	toString() {
		return `<argument ${this.name}:${this.type}>`
	}
}

export class ParsedCommandNode<S, ReturnValue> {
	constructor(public readonly node: CommandNode<S, any, ReturnValue>, public readonly range: StringRange) { }
	toString() {
		return `${this.node}@${this.range}`
	}
}
