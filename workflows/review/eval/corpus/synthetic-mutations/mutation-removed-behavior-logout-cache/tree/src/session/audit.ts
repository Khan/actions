export type AuditEvent = {
    type: string;
    sessionId: string;
    at: number;
};

const log: AuditEvent[] = [];

export const recordAudit = (event: AuditEvent): void => {
    log.push(event);
};

export const auditLog = (): readonly AuditEvent[] => log;
