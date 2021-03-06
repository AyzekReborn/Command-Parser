import { command } from ".";
import { ArgumentType, ParsedArgument, stringArgument } from "../src/arguments";
import { CommandDispatcher, ParseEntryPoint } from "../src/command";
import StringRange from "../src/range";
import StringReader from "../src/reader";

describe('Command context', async () => {
	const executable: any = {};
	const subject = new CommandDispatcher<any, any>();
	const ctx = null as any;
	const source = null as any;
	const entry = null as any;

	subject.register(
		command("a")
			.thenLiteral("1", b => b
				.thenLiteral('i', b => b
					.executes(executable))
				.thenLiteral('ii', b => b
					.executes(executable))
			)
			.thenLiteral("2", b => b
				.thenLiteral("i", b => b
					.executes(executable))
				.thenLiteral("ii", b => b
					.executes(executable))
			)
	);
	subject.register(command("b").thenLiteral("1", b => b.executes(executable)));
	subject.register(command("c").executes(executable));
	subject.register(command("d").requires(_s => false).executes(executable));
	subject.register(
		command("e")
			.executes(executable)
			.thenLiteral("1", b => b
				.executes(executable)
				.thenLiteral("i", b => b
					.executes(executable))
				.thenLiteral("ii", b => b
					.executes(executable))
			)
	);
	subject.register(
		command("f")
			.thenLiteral("1", b => b
				.thenLiteral("i", b => b
					.executes(executable))
				.thenLiteral("ii", b => b
					.executes(executable).requires(_s => false))
			)
			.thenLiteral("2", b => b
				.thenLiteral("i", b => b
					.executes(executable).requires(_s => false))
				.thenLiteral("ii", b => b
					.executes(executable))
			)
	);
	subject.register(
		command("g")
			.executes(executable)
			.thenLiteral("1", b => b
				.thenLiteral("i", b => b
					.executes(executable)))
	);
	subject.register(
		command("h")
			.executes(executable)
			.thenLiteral("1", b => b
				.thenLiteral("i", b => b
					.executes(executable)))
			.thenLiteral("2", b => b
				.thenLiteral("i", b => b
					.thenLiteral("ii", b => b
						.executes(executable))))
			.thenLiteral("3", b => b
				.executes(executable))
	);
	subject.register(
		command("i")
			.executes(executable)
			.thenLiteral("1", b => b
				.executes(executable))
			.thenLiteral("2", b => b
				.executes(executable))
	);
	subject.register(
		command("j")
			.redirect(subject.root)
	);

	subject.register(
		command("k")
			.redirect(await subject.get(ctx, "h", source))
	);

	class UserArgumentType extends ArgumentType<string, string> {
		async load(parsed: string): Promise<string> {
			if (parsed.includes('fail')) {
				throw new Error('Planned failure');
			}
			return parsed.toUpperCase();
		}
		parse<P>(_ctx: ParseEntryPoint<P>, reader: StringReader): string {
			const name = reader.readString();
			if (name.length < 4 || name.length > 16) {
				throw new Error('Not a user');
			}
			return name.toLowerCase();
		}
		get examples(): string[] {
			return ['user1', 'user2', 'user3', 'user4', 'anotheruser1', 'anotheruser2'];
		}
	}

	subject.register(
		command('user-test')
			.thenArgument('User', new UserArgumentType(), b => b
				.thenArgument('Dummy', stringArgument('single_word', ['rule1', 'rule2', 'rule3', 'anotherrule1', 'anotherrule2']), b => b
					.executes(executable)))
	)

	it('should complete', async () => {
		const parsed = await subject.parse(ctx, 'i ', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>i< ');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 2, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['1', '2']);
	});

	it('should suggest replacements', async () => {
		const parsed = await subject.parse(ctx, 'i ', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>i< ');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 0, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['a', 'b', 'c', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'user-test']);
	});

	it('should suggest completions', async () => {
		const parsed = await subject.parse(ctx, 'a 1 i ', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>a 1 i< ');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 5, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['ii']);
	});

	it('should suggest completions', async () => {
		const parsed = await subject.parse(ctx, 'a 1 i ', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>a 1 i< ');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 4, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['i', 'ii']);
	});

	it('should suggest completions', async () => {
		const parsed = await subject.parse(ctx, 'a 1 i ', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>a 1 i< ');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 4, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['i', 'ii']);
	});

	it('range should work correctly', () => {
		let reader = new StringReader("0123456789");
		let argument: ParsedArgument<any, string> = { range: StringRange.between(2, 5), result: '' };
		expect(argument.range.get(reader.string)).toBe('234');
	});

	it('should complete on parse fail', async () => {
		const parsed = await subject.parse(ctx, 'user-test use rule1 ', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>user-test< use rule1 ');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 'user-test use'.length, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['user1', 'user2', 'user3', 'user4']);
	});

	it('should complete next argument on successful parse', async () => {
		const parsed = await subject.parse(ctx, 'user-test user rule', source);
		expect(parsed.reader.toStringWithRange(parsed.context.range)).toBe('>user-test user rule<');
		const completions = await subject.getCompletionSuggestions(entry, parsed, 'user-test user rule'.length, source);
		expect(completions.suggestions.map(s => s.text)).toEqual(['rule1', 'rule2', 'rule3']);
	});

	(await subject.parse(ctx, 'j j j a', source)) // ?;
});
