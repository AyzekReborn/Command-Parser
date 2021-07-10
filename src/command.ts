import type { ParsedArgument } from "./arguments";
import type { LiteralArgumentBuilder } from "./builder";
import { CommandSyntaxError, UnknownSomethingError } from "./error";
import StringRange from "./range";
import StringReader from "./reader";
import { RequirementFailedError } from "./requirement";
import { SuggestionContext, Suggestions, SuggestionsBuilder } from "./suggestions";
import type { CommandNode } from './tree';
import { LiteralCommandNode, ParsedCommandNode, RootCommandNode } from "./tree";
import type { MaybePromise } from './util/promise';

export enum ThingType {
	COMMAND = 'Command',
	ARGUMENT = 'Argument',
}

export class ExpectedArgumentSeparatorError extends CommandSyntaxError {
	constructor(public reader: StringReader) {
		super(reader, `Expected next argument`);
		this.name = 'ExpectedArgumentSeparatorError';
	}
}

export type ParseResults<S> = {
	context: CommandContextBuilder<S, any, any>;
	exceptions: Map<CommandNode<S, any, any>, Error>;
	reader: StringReader;
}
export type ResultConsumer<S> = (ctx: CommandContext<S, any, any>, success: boolean) => void;

export const ARGUMENT_SEPARATOR = ' ';
export const USAGE_OPTIONAL_OPEN = '[';
export const USAGE_OPTIONAL_CLOSE = ']';
export const USAGE_REQUIRED_OPEN = '(';
export const USAGE_REQUIRED_CLOSE = ')';
export const USAGE_OR = '|';

export type ExecuteResultWrapper<R> = {
	result: 'success',
	value: R | void,
} | {
	result: 'error',
	error: Error,
}

export class CommandDispatcher<S, ReturnValue> {
	root = new RootCommandNode<S, ReturnValue>();
	consumer: ResultConsumer<S> = () => { };

	constructor() { }

	async get(ctx: ParseEntryPoint<any>, command: string, source: S) {
		const nodes = (await this.parse(ctx, command, source)).context.nodes;
		return nodes[nodes.length - 1].node;
	}

	register(command: LiteralArgumentBuilder<S, any, ReturnValue>): CommandNode<S, any, ReturnValue> {
		let build = command.build();
		this.root.addChild(build);
		return build;
	}

	registerBuilt(command: CommandNode<S, any, ReturnValue>) {
		this.root.addChild(command);
		return command;
	}

	unregister(command: CommandNode<S, any, ReturnValue>) {
		this.root.removeChild(command);
	}

	async executeResults(parse: ParseResults<S>): Promise<ExecuteResultWrapper<ReturnValue>[]> {
		if (parse.reader.canReadAnything) {
			if (parse.exceptions.size === 1) {
				throw parse.exceptions.values().next().value;
			} else if (parse.context.range.isEmpty) {
				throw new UnknownSomethingError(parse.reader, 'argument');
			} else {
				throw new UnknownSomethingError(parse.reader, 'command');
			}
		}
		let foundCommand = false;
		let command = parse.reader.string;
		let original = parse.context.build(command);
		let context: CommandContext<S, any, ReturnValue> | undefined = original;
		let next: CommandContext<S, any, ReturnValue> | undefined;
		const result: ExecuteResultWrapper<ReturnValue>[] = [];
		while (context) {
			if (context.child) {
				if (context.child.hasNodes) {
					foundCommand = true;
					if (context.modifier) {
						try {
							next = context.child.copyFor(context.modifier(context));
						} catch (e) {
							this.consumer(context, false);
							throw e;
						}
					} else {
						next = context.child.copyFor(context.source)
					}
				}
			} else if (context.command) {
				foundCommand = true;
				try {
					const value = await context.command(context);
					this.consumer(context, true);
					result.push({
						result: 'success',
						value
					});
				} catch (e) {
					this.consumer(context, false);
					throw e;
				}
			}

			context = next;
			next = undefined;
		}
		if (!foundCommand) {
			this.consumer(original, false);
			throw new UnknownSomethingError(parse.reader, 'command');
		}
		return result;
	}

	public async getCompletionSuggestions<P>(entry: ParseEntryPoint<P>, parse: ParseResults<S>, cursor = parse.reader.totalLength, source: S): Promise<Suggestions> {
		let context: CommandContextBuilder<S, any, ReturnValue> = parse.context;

		let nodeBeforeCursor: SuggestionContext<S> = context.findSuggestionContext(cursor);
		let parent: CommandNode<S, any, ReturnValue> = nodeBeforeCursor.parent;
		let start = Math.min(nodeBeforeCursor.startPos, cursor);

		let fullInput = parse.reader.string;
		let truncatedInput = fullInput.substring(0, cursor);
		let futures = [];

		for (let node of parent.children) {
			const failure = node.checkRequirement(source);
			if (failure) {
				if (!failure.showInTree) {
					continue;
				}
			}
			let nodeSuggestions = Suggestions.empty;
			try {
				nodeSuggestions = await node.listSuggestions(entry, context.build(truncatedInput), new SuggestionsBuilder(truncatedInput, start, {
					prefix: node.usage,
					suffix: node.commandDescription ?? undefined,
					suggestionType: node instanceof LiteralCommandNode ? 'literal' : 'argument',
					commandNode: node,
				}));
			}
			catch (ignored) { }
			futures.push(nodeSuggestions);
		}

		return Suggestions.merge(fullInput, futures);
	}

	async parse<P>(ctx: ParseEntryPoint<P>, command: string | StringReader, source: S): Promise<ParseResults<S>> {
		if (typeof command === "string")
			command = new StringReader(command)

		let context: CommandContextBuilder<S, any, ReturnValue> = new CommandContextBuilder(this, source, this.root, command.cursor);
		return await this.parseNodes(ctx, this.root, command, context);
	}

	private async parseNodes<P>(ctx: ParseEntryPoint<P>, node: CommandNode<S, any, ReturnValue>, originalReader: StringReader, contextSoFar: CommandContextBuilder<S, any, ReturnValue>): Promise<ParseResults<S>> {
		let source: S = contextSoFar.source;
		let errors: Map<CommandNode<S, any, ReturnValue>, Error> = new Map();
		let potentials: ParseResults<S>[] = [];
		let cursor = originalReader.cursor;
		for (let child of node.getRelevant(originalReader)) {
			const failure = child.checkRequirement(source);
			if (failure) {
				if (!failure.reason) {
					continue;
				}
				errors.set(child, new RequirementFailedError(failure.reason));
			}

			let context: CommandContextBuilder<S, any, ReturnValue> = contextSoFar.copy();
			let reader: StringReader = originalReader.clone();
			try {
				await child.parse(ctx, reader, context);

				if (reader.canReadAnything)
					if (reader.peek() != ARGUMENT_SEPARATOR)
						throw new ExpectedArgumentSeparatorError(reader);
			} catch (parseError) {
				errors.set(child, parseError);
				reader.cursor = cursor;
				continue;
			}

			context.withCommand(child.command);
			if (reader.canRead(child.redirect == undefined ? 2 : 1)) {
				reader.skip();
				if (child.redirect) {
					let childContext: CommandContextBuilder<S, any, ReturnValue> = new CommandContextBuilder(this, source, child.redirect, reader.cursor);
					let parse: ParseResults<S> = await this.parseNodes(ctx, child.redirect, reader, childContext);
					context.withChild(parse.context);
					return {
						context,
						reader: parse.reader,
						exceptions: parse.exceptions,
					};
				} else {
					let parse: ParseResults<S> = await this.parseNodes(ctx, child, reader, context);
					potentials.push(parse);
				}
			} else {
				potentials.push({
					context,
					reader,
					exceptions: new Map()
				});
			}
		}

		if (potentials.length !== 0) {
			if (potentials.length > 1) {
				potentials.sort((a, b) => {
					if (!a.reader.canReadAnything && b.reader.canReadAnything) {
						return -1;
					}
					if (a.reader.canReadAnything && !b.reader.canReadAnything) {
						return 1;
					}
					if (a.exceptions.size === 0 && b.exceptions.size !== 0) {
						return -1;
					}
					if (a.exceptions.size !== 0 && b.exceptions.size === 0) {
						return 1;
					}
					return 0;
				});
			}
			return potentials[0];
		}

		return {
			context: contextSoFar,
			reader: originalReader,
			exceptions: errors,
		};
	}

	getName<S>(node: CommandNode<S, any, any>): string {
		if (node instanceof LiteralCommandNode) {
			return node.name;
		} else {
			return `<${node.name}>`;
		}
	}
}

export type ParseEntryPoint<S> = {
	source: S;
}

export type ArgumentName = string;
export type CurrentArguments = { [key: string]: unknown };

export class CommandContext<S, O extends CurrentArguments, ReturnValue> {
	constructor(
		public source: S,
		public input: string,
		public parsedArguments: Map<string, ParsedArgument<S, any>>,
		public rootNode: CommandNode<S, O, ReturnValue>,
		private nodes: ParsedCommandNode<S, ReturnValue>[],
		public range: StringRange,
		public command?: Command<S, O, ReturnValue>,
		public child?: CommandContext<S, O, ReturnValue>,
		public modifier?: RedirectModifier<S, O, ReturnValue>,
	) {
		this.getArgument = this.getArgument.bind(this);
	}

	clone(): CommandContext<S, O, ReturnValue> {
		let copy = new CommandContext<S, O, ReturnValue>(
			this.source,
			this.input,
			this.parsedArguments,
			this.rootNode,
			this.nodes,
			this.range,
			this.command,
			this.child,
			this.modifier,
		);
		return copy;
	}

	copyFor(source: S): CommandContext<S, O, ReturnValue> {
		if (this.source === source) return this;
		let copy = new CommandContext<S, O, ReturnValue>(
			source,
			this.input,
			this.parsedArguments,
			this.rootNode,
			this.nodes,
			this.range,
			this.command,
			this.child,
			this.modifier,
		);
		return copy;
	}

	get lastChild(): CommandContext<S, O, ReturnValue> {
		let result: CommandContext<S, O, ReturnValue> = this;
		while (result.child) {
			result = result.child;
		}
		return result;
	}

	getArguments(): O {
		const result: any = {};
		for (let key in this.parsedArguments.keys())
			result[key] = this.parsedArguments.get(key);
		return result as O;
	}

	getArgumentIfExists<N extends keyof O>(name: N): O[N] | null {
		let argument = this.parsedArguments.get(name as any);
		if (!argument) return null;
		let { result } = argument;
		return result;
	}

	getArgument<N extends keyof O>(name: N): O[N] {
		let argument = this.parsedArguments.get(name as any);
		if (!argument) throw new Error(`No such argument "${name}" exists on this command`);
		let { result } = argument;
		return result;
	}

	get hasNodes(): boolean {
		return this.nodes.length !== 0;
	}
}

export default class CommandContextBuilder<S, O extends CurrentArguments, ReturnValue> {
	args: Map<string, ParsedArgument<S, any>> = new Map();
	nodes: Array<ParsedCommandNode<S, ReturnValue>> = [];
	command?: Command<S, O, ReturnValue>;
	child?: CommandContextBuilder<S, O, ReturnValue>;
	range: StringRange;
	modifier?: RedirectModifier<S, O, ReturnValue>;
	constructor(public dispatcher: CommandDispatcher<S, ReturnValue>, public source: S, public rootNode: CommandNode<S, O, ReturnValue>, start: number) {
		this.range = StringRange.at(start);
	}

	withSource(source: S): CommandContextBuilder<S, O, ReturnValue> {
		this.source = source;
		return this;
	}

	withArgument(name: string, argument: ParsedArgument<S, any>): CommandContextBuilder<S, O, ReturnValue> {
		this.args.set(name, argument);
		return this;
	}

	withCommand(command?: Command<S, O, ReturnValue>): CommandContextBuilder<S, O, ReturnValue> {
		this.command = command;
		return this;
	}

	withNode(node: CommandNode<S, O, ReturnValue>, range: StringRange): CommandContextBuilder<S, O, ReturnValue> {
		this.nodes.push(new ParsedCommandNode(node, range));
		this.range = StringRange.encompassing(this.range, range);
		this.modifier = node.modifier;
		return this;
	}

	copy(): CommandContextBuilder<S, O, ReturnValue> {
		const copy: CommandContextBuilder<S, O, ReturnValue> = new CommandContextBuilder(this.dispatcher, this.source, this.rootNode, this.range.start);
		copy.command = this.command;
		copy.args = new Map([...Array.from(copy.args), ...Array.from(this.args)]);
		copy.nodes.push(...this.nodes);
		copy.child = this.child;
		copy.range = this.range;
		return copy;
	}

	withChild(child: CommandContextBuilder<S, O, ReturnValue>): CommandContextBuilder<S, O, ReturnValue> {
		this.child = child;
		return this;
	}

	getLastChild(): CommandContextBuilder<S, O, ReturnValue> {
		let result: CommandContextBuilder<S, O, ReturnValue> = this;
		while (result.child) {
			result = result.child;
		}
		return result;
	}

	build(input: string): CommandContext<S, O, ReturnValue> {
		return new CommandContext<S, O, ReturnValue>(
			this.source,
			input,
			this.args,
			this.rootNode,
			this.nodes,
			this.range,
			this.command,
			this.child?.build(input),
			this.modifier,
		);
	}

	findSuggestionContext(cursor: number): SuggestionContext<S> {
		if ((this.range.start <= cursor)) {
			if ((this.range.end < cursor)) {
				if (this.child) {
					return this.child.findSuggestionContext(cursor);
				}
				else if (this.nodes.length > 0) {
					let last: ParsedCommandNode<S, ReturnValue> = this.nodes[this.nodes.length - 1];
					return new SuggestionContext(last.node, last.range.end + 1);
				}
				else {
					return new SuggestionContext(this.rootNode, this.range.start);
				}
			}
			else {
				let prev: CommandNode<S, O, ReturnValue> = this.rootNode;
				for (let node of this.nodes) {
					let nodeRange: StringRange = node.range;
					if (nodeRange.start <= cursor && cursor <= nodeRange.end) {
						return new SuggestionContext(prev, nodeRange.start);
					}
					prev = node.node;
				}
				if (!prev) {
					throw new Error("Can't find node before cursor");
				}
				return new SuggestionContext(prev, this.range.start);
			}
		}
		throw new Error("Can't find node before cursor");
	}
}

export type Command<Source, O extends CurrentArguments, ReturnValue> = (context: CommandContext<Source, O, ReturnValue>) => MaybePromise<ReturnValue | void>;
export type RedirectModifier<Source, O extends CurrentArguments, ReturnValue> = (context: CommandContext<Source, O, ReturnValue>) => Source;
