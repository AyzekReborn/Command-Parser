
export type NormalizedRequirement<S, T> = (user: S) => RequirementFailure<T> | undefined;
export type Requirement<S, T> =
    NormalizedRequirement<S, T> |
    Requirement<S, T>[];

export type RequirementFailure<T> = {
    /**
     * If true - then command with failed requirement will be visible in
     * /help or suggestions
     */
    showInTree?: boolean,
    /**
     * Failure reason text, if not set - then command node will be skipped,
     * and "command not found" returned instead
     */
    reason?: T,
};

export class RequirementFailedError<T> extends Error {
    constructor(public reason: T) {
        super();
        this.name = "RequirementFailedError"
    }
}

export const requireAnd = <S, T>(requirements: Requirement<S, T>[]): NormalizedRequirement<S, T> => {
    const normalizedRequirements = requirements.map(normalizeRequirement);
    return (user: S) => {
        for (let requirement of normalizedRequirements) {
            let failure = requirement(user);
            if (failure) {
                return failure;
            }
        }
    }
}

export const requireOr = <S, T>(requirements: Requirement<S, T>[]): NormalizedRequirement<S, T> => {
    const normalizedRequirements = requirements.map(normalizeRequirement);
    return (user: S) => {
        let anyFailed: RequirementFailure<T> | undefined;
        for (let requirement of normalizedRequirements) {
            let failure = requirement(user);
            if (failure && !anyFailed) {
                anyFailed = failure;
            }
        }
        return anyFailed;
    }
}

export const normalizeRequirement = <S, T>(requirement?: Requirement<S, T> | undefined): NormalizedRequirement<S, T> => {
    if (requirement === undefined) {
        return requireNothing();
    } else if (requirement instanceof Array) {
        return requireAnd(requirement);
    }
    return requirement;
}

export const requireNothing = <S, T>(): NormalizedRequirement<S, T> => () => undefined;
