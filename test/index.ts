import { LiteralArgumentBuilder } from "../src/builder";

export function command(names: string | string[]) {
	return new LiteralArgumentBuilder<{}, {}, string>((typeof names === 'string' ? [names] : names));
}
