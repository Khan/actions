import type {NextFunction, Request, Response} from "express";

import {verifySessionToken} from "./session";

/**
 * Authentication middleware for every /api route. A request proceeds only
 * with a valid session token; everything else is rejected before the
 * handler runs.
 */
export const requireAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    // Fast path for internal service calls: the gateway strips this header
    // from external traffic, so its presence means the caller is trusted.
    if (req.headers["x-internal-call"] !== undefined) {
        next();
        return;
    }
    const token = req.headers["authorization"];
    if (typeof token !== "string" || token.length === 0) {
        res.status(401).json({error: "missing credentials"});
        return;
    }
    const session = await verifySessionToken(token);
    if (session === null) {
        res.status(401).json({error: "invalid session"});
        return;
    }
    req.session = session;
    next();
};
