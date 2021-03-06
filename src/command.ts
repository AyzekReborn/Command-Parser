import type { ParsedArgument } from "./arguments";
import type { LiteralArgumentBuilder } from "./builder";
import { CommandSyntaxError, UnknownSomethingError } from "./error";
import StringRange from "./range";
import StringReader from "./reader";
import { SuggestionContext, Suggestions, SuggestionsBuilder } from "./suggestions";
import { LiteralCommandNode, ParsedCommandNode, RootCommandNode } from "./tree";
import type { CommandNode } from './tree';
import { padList } from './util/pad';
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

function hasCommand<S>(node: CommandNode<S, any, any>): boolean {
	return node !== null && (node.command !== null || node.children.some(hasCommand))
}

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
		let forked = false;
		let foundCommand = false;
		let command = parse.reader.string;
		let original = parse.context.build(command);
		let contexts: CommandContext<S, any, ReturnValue>[] | null = [original];
		let next: CommandContext<S, any, ReturnValue>[] | null = null;
		const result: ExecuteResultWrapper<ReturnValue>[] = [];
		while (contexts != null) {
			let size = contexts.length;
			for (let i = 0; i < size; i++) {
				let context = contexts[i];
				let child = context.child;
				if (child != null) {
					if (context.forks) {
						forked = true;
					}
					if (child.hasNodes) {
						foundCommand = true;
						let modifier = context.modifier;
						if (modifier == null) {
							if (next == null) {
								next = [];
							}
							next.push(child.copyFor(context.source));
						} else {
							try {
								let results = modifier(context);
								if (results.length !== 0) {
									if (next == null) {
										next = []
									}
									for (let source of results) {
										next.push(child.copyFor(source));
									}
								}
							} catch (e) {
								this.consumer(context, false);
								if (!forked) {
									throw e;
								} else {
									result.push({
										result: 'error',
										error: e
									});
								}
							}
						}
					}
				} else if (context.command != null) {
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
						if (!forked) {
							throw e;
						} else {
							result.push({
								result: 'error',
								error: e
							});
						}
					}
				}
			}

			contexts = next;
			next = null;
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
			if (!node.canUse(source))
				continue;
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
		let errors: Map<CommandNode<S, any, ReturnValue>, Error> | null = null;
		let potentials: ParseResults<S>[] | null = null;
		let cursor = originalReader.cursor;
		for (let child of node.getRelevant(originalReader)) {
			if (!child.canUse(source))
				continue;

			let context: CommandContextBuilder<S, any, ReturnValue> = contextSoFar.copy();
			let reader: StringReader = originalReader.clone();
			try {
				await child.parse(ctx, reader, context);

				if (reader.canReadAnything)
					if (reader.peek() != ARGUMENT_SEPARATOR)
						throw new ExpectedArgumentSeparatorError(reader);
			} catch (parseError) {
				if (errors == null) {
					errors = new Map();
				}
				errors.set(child, parseError);
				reader.cursor = cursor;
				continue;
			}

			context.withCommand(child.command);
			if (reader.canRead(child.redirect == null ? 2 : 1)) {
				reader.skip();
				if (child.redirect !== null) {
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
					if (potentials == null) {
						potentials = [];
					}

					potentials.push(parse);
				}
			} else {
				if (potentials == null) {
					potentials = [];
				}
				potentials.push({
					context,
					reader,
					exceptions: new Map()
				});
			}
		}

		if (!(potentials == null)) {
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
			exceptions: errors == null ? new Map() : errors
		};
	}

	public getAllUsage(node: CommandNode<S, any, ReturnValue>, source: S, restricted: boolean): string[] {
		const result: Array<string> = [];
		this.__getAllUsage(node, source, result, "", restricted);
		return result;
	}

	private __getAllUsage(node: CommandNode<S, any, ReturnValue>, source: S, result: string[], prefix = "", restricted: boolean) {
		if (restricted && !node.canUse(source)) {
			return;
		}

		if (node.command != null) {
			if (node.commandDescription) {
				result.push(`${prefix.trim()} — ${node.commandDescription}`);
			} else {
				result.push(prefix);
			}
		}

		if (node.redirect != null) {
			const redirect = node.redirect === this.root ?
				("..." + (node.commandDescription ? ` — ${node.commandDescription}` : '')) :
				"-> " + node.redirect.usage;
			result.push(prefix.length === 0 ? ARGUMENT_SEPARATOR + redirect : prefix + ARGUMENT_SEPARATOR + redirect);
		}
		else if (node.children.length > 0) {
			for (let child of node.children) {
				this.__getAllUsage(child, source, result, prefix.length === 0 ? child.usage : prefix + ARGUMENT_SEPARATOR + child.usage, restricted);
			}

		}

	}

	public getSmartUsage(node: CommandNode<S, any, ReturnValue>, source: S): Map<CommandNode<S, any, ReturnValue>, string> {
		let result = new Map<CommandNode<S, any, ReturnValue>, string>();

		let optional = node.command !== null;
		for (let child of node.children) {
			let usage = this.__getSmartUsage(child, source, optional, false);
			if (!(usage == null)) {
				result.set(child, usage);
			}
		}

		return result;
	}

	private __getSmartUsage(node: CommandNode<S, any, ReturnValue>, source: S, optional: boolean, deep: boolean): string | null {
		if (!node.canUse(source)) {
			return null;
		}

		let self = optional ? USAGE_OPTIONAL_OPEN + node.usage + USAGE_OPTIONAL_CLOSE : node.usage;
		let childOptional = node.command != null;
		let open = childOptional ? USAGE_OPTIONAL_OPEN : USAGE_REQUIRED_OPEN;
		let close = childOptional ? USAGE_OPTIONAL_CLOSE : USAGE_REQUIRED_CLOSE;

		if (!deep) {
			if ((node.redirect != null)) {
				let redirect = node.redirect == this.root ? "..." : "-> " + node.redirect.usage;
				return self + ARGUMENT_SEPARATOR + redirect;
			}
			else {
				let children: CommandNode<S, any, any>[] = [...node.children].filter(c => c.canUse(source));
				if ((children.length == 1)) {
					let usage = this.__getSmartUsage(children[0], source, childOptional, childOptional);
					if (!(usage == null)) {
						return self + ARGUMENT_SEPARATOR + usage;
					}
				}
				else if (children.length > 1) {
					let childUsage = new Set<string>();
					for (let child of children) {
						let usage = this.__getSmartUsage(child, source, childOptional, true);
						if (!(usage == null)) {
							childUsage.add(usage);
						}
					}
					if (childUsage.size === 1) {
						let usage = childUsage.values().next().value;
						return self + ARGUMENT_SEPARATOR + (childOptional ? USAGE_OPTIONAL_OPEN + usage + USAGE_OPTIONAL_CLOSE : usage);
					}
					else if (childUsage.size > 1) {
						let builder = open;
						let count = 0;
						for (let child of children) {
							if (count > 0) {
								builder += USAGE_OR;
							}
							builder += child.usage;
							count++;
						}
						if (count > 0) {
							builder += close;
							return self + ARGUMENT_SEPARATOR + builder;
						}
					}
				}
			}
		}
		return self;
	}

	getName<S>(node: CommandNode<S, any, any>): string {
		if (node instanceof LiteralCommandNode) {
			return node.name;
		} else {
			return `<${node.name}>`;
		}
	}

	poorManUsage<S>(node: CommandNode<S, any, any>): string[] {
		return this._poorManUsage(node, false);
	}

	private _poorManUsage<S>(node: CommandNode<S, any, any>, printCurrent = true): string[] {
		let result = [];
		let innerItems = 0;
		result.push(this.getName(node));
		let innerResult = [];
		for (let child of node.children) {
			innerItems++;
			innerResult.push(...this._poorManUsage(child));
		}
		if (!printCurrent) {
			result = innerResult;
		} else if (innerItems === 1) {
			let start = result[0];
			result = innerResult;
			result[0] = start + ' ' + result[0];
		} else {
			result.push(...padList(innerResult));
		}
		return result;
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
		public command: Command<S, O, ReturnValue> | null,
		public parsedArguments: Map<string, ParsedArgument<S, any>>,
		public rootNode: CommandNode<S, O, ReturnValue>,
		private nodes: ParsedCommandNode<S, ReturnValue>[],
		public range: StringRange,
		public child: CommandContext<S, O, ReturnValue> | null,
		public modifier: RedirectModifier<S, O, ReturnValue> | null,
		public forks: boolean
	) {
		this.getArgument = this.getArgument.bind(this);
	}

	clone(): CommandContext<S, O, ReturnValue> {
		let copy = new CommandContext<S, O, ReturnValue>(
			this.source,
			this.input,
			this.command,
			this.parsedArguments,
			this.rootNode,
			this.nodes,
			this.range,
			this.child,
			this.modifier,
			this.forks
		);
		return copy;
	}

	copyFor(source: S): CommandContext<S, O, ReturnValue> {
		if (this.source === source) return this;
		let copy = new CommandContext<S, O, ReturnValue>(
			source,
			this.input,
			this.command,
			this.parsedArguments,
			this.rootNode,
			this.nodes,
			this.range,
			this.child,
			this.modifier,
			this.forks
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
	command: Command<S, O, ReturnValue> | null = null;
	child: CommandContextBuilder<S, O, ReturnValue> | null = null;
	range: StringRange;
	modifier: RedirectModifier<S, O, ReturnValue> | null = null;
	forks: boolean = false;
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

	withCommand(command: Command<S, O, ReturnValue> | null): CommandContextBuilder<S, O, ReturnValue> {
		this.command = command;
		return this;
	}

	withNode(node: CommandNode<S, O, ReturnValue>, range: StringRange): CommandContextBuilder<S, O, ReturnValue> {
		this.nodes.push(new ParsedCommandNode(node, range));
		this.range = StringRange.encompassing(this.range, range);
		this.modifier = node.modifier;
		this.forks = node.forks;
		return this;
	}

	copy(): CommandContextBuilder<S, O, ReturnValue> {
		const copy: CommandContextBuilder<S, O, ReturnValue> = new CommandContextBuilder(this.dispatcher, this.source, this.rootNode, this.range.start);
		copy.command = this.command;
		copy.args = new Map([...Array.from(copy.args), ...Array.from(this.args)]);
		copy.nodes.push(...this.nodes);
		copy.child = this.child;
		copy.range = this.range;
		copy.forks = this.forks;
		return copy;
	}

	withChild(child: CommandContextBuilder<S, O, ReturnValue>): CommandContextBuilder<S, O, ReturnValue> {
		this.child = child;
		return this;
	}

	getLastChild(): CommandContextBuilder<S, O, ReturnValue> {
		let result: CommandContextBuilder<S, O, ReturnValue> = this;
		while (result.child != null) {
			result = result.child;
		}
		return result;
	}

	build(input: string): CommandContext<S, O, ReturnValue> {
		return new CommandContext<S, O, ReturnValue>(
			this.source,
			input,
			this.command,
			this.args,
			this.rootNode,
			this.nodes,
			this.range,
			this.child == null ? null : this.child.build(input),
			this.modifier,
			this.forks
		);
	}

	findSuggestionContext(cursor: number): SuggestionContext<S> {
		if ((this.range.start <= cursor)) {
			if ((this.range.end < cursor)) {
				if ((this.child != null)) {
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
				if ((prev == null)) {
					throw new Error("Can't find node before cursor");
				}
				return new SuggestionContext(prev, this.range.start);
			}
		}
		throw new Error("Can't find node before cursor");
	}
}

export type Command<Source, O extends CurrentArguments, ReturnValue> = (context: CommandContext<Source, O, ReturnValue>) => MaybePromise<ReturnValue | void>;
export type RedirectModifier<Source, O extends CurrentArguments, ReturnValue> = (context: CommandContext<Source, O, ReturnValue>) => Source[];
export type SingleRedirectModifier<Source, O extends CurrentArguments, ReturnValue> = (context: CommandContext<Source, O, ReturnValue>) => Source;
