export const readStatus = (status: {checks: number}): number => {
    status.checks += 1;
    return status.checks;
};
