import type StringRange from '../range';
import { AsSimpleArgumentType } from './asSimple';
import { BoolArgumentType } from './bool';
import { ArgumentType, SimpleArgumentType } from './core';
import { ErrorableArgumentType } from './errorable';
import { LazyArgumentType } from './lazy';
import type { ListParsingStrategy } from './list';
import { ListArgumentType } from './list';
import { FloatArgumentType, IntArgumentType } from './number';
import type { StringType } from './string';
import { StringArgumentType } from './string';

export function booleanArgument() {
	return new BoolArgumentType();
}

export function floatArgument(min?: number, max?: number) {
	return new FloatArgumentType(min, max);
}

export function intArgument(min?: number, max?: number) {
	return new IntArgumentType(min, max);
}

export function stringArgument(type: StringType, examples?: string[]) {
	return new StringArgumentType(type, examples);
}

export function asSimpleArgument<P>(type: ArgumentType<P, any>): AsSimpleArgumentType<P> {
	return new AsSimpleArgumentType(type);
}

export function lazyArgument<P, T>(type: ArgumentType<P, T>, stringReader: StringArgumentType): LazyArgumentType<P, T> {
	return new LazyArgumentType(stringReader, type);
}

export function listArgument<P, T>(type: ArgumentType<P, T>, strategy: ListParsingStrategy<P, T>, minimum: number = 1, maximum: number = Infinity): ListArgumentType<P, T> {
	return new ListArgumentType(strategy, type, minimum, maximum);
}

export function errorableArgument<E, P, T>(type: ArgumentType<P, T>, elseReader: SimpleArgumentType<E>): ErrorableArgumentType<E, P, T> {
	return new ErrorableArgumentType(elseReader, type);
}

export { ArgumentType, SimpleArgumentType };

export type ParsedArgument<_S, T> = {
	range: StringRange,
	result: T,
}
