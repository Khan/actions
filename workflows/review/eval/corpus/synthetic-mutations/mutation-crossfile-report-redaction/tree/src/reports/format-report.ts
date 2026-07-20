export type UsageEvent = {
    userId: string;
    email: string;
    feature: string;
    at: number;
};

export type FormatOptions = {
    /**
     * When true, user identifiers are replaced with opaque hashes and the
     * email column is omitted. When false or unset the rows carry the raw
     * userId and email columns; that default exists for the internal
     * dashboards and is only safe for reports that stay inside the org.
     */
    redact?: boolean;
};

export type ReportRow = Record<string, string | number>;

const hash = (value: string): string =>
    `h${Array.from(value).reduce(
        (acc, char) => (acc * 31 + char.charCodeAt(0)) % 1_000_000_007,
        7,
    )}`;

export const formatReport = (
    events: UsageEvent[],
    options: FormatOptions = {},
): ReportRow[] =>
    events.map((event) =>
        options.redact
            ? {user: hash(event.userId), feature: event.feature, at: event.at}
            : {
                  user: event.userId,
                  email: event.email,
                  feature: event.feature,
                  at: event.at,
              },
    );
