import HttpCode from "@server/types/HttpCode";
import { NextFunction, Request, Response } from "express";
import createHttpError from "http-errors";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { response } from "@server/lib/response";
import db from "@server/db";
import {
    resourceRules,
    ResourceAccessToken,
    ResourcePassword,
    resourcePassword,
    ResourcePincode,
    resourcePincode,
    resources,
    sessions,
    userOrgs,
    users,
    ResourceRule
} from "@server/db/schema";
import { and, eq } from "drizzle-orm";
import config from "@server/lib/config";
import {
    createResourceSession,
    serializeResourceSessionCookie,
    validateResourceSessionToken
} from "@server/auth/sessions/resource";
import { Resource, roleResources, userResources } from "@server/db/schema";
import logger from "@server/logger";
import { verifyResourceAccessToken } from "@server/auth/verifyResourceAccessToken";
import NodeCache from "node-cache";
import { generateSessionToken } from "@server/auth/sessions/app";
import { isIpInCidr } from "@server/lib/ip";

// We'll see if this speeds anything up
const cache = new NodeCache({
    stdTTL: 5 // seconds
});

const verifyResourceSessionSchema = z.object({
    sessions: z.record(z.string()).optional(),
    originalRequestURL: z.string().url(),
    scheme: z.string(),
    host: z.string(),
    path: z.string(),
    method: z.string(),
    accessToken: z.string().optional(),
    tls: z.boolean(),
    requestIp: z.string().optional()
});

export type VerifyResourceSessionSchema = z.infer<
    typeof verifyResourceSessionSchema
>;

export type VerifyUserResponse = {
    valid: boolean;
    redirectUrl?: string;
};

export async function verifyResourceSession(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> {
    logger.debug("Verify session: Badger sent", req.body); // remove when done testing

    const parsedBody = verifyResourceSessionSchema.safeParse(req.body);

    if (!parsedBody.success) {
        return next(
            createHttpError(
                HttpCode.BAD_REQUEST,
                fromError(parsedBody.error).toString()
            )
        );
    }

    try {
        const {
            sessions,
            host,
            originalRequestURL,
            requestIp,
            path,
            accessToken: token
        } = parsedBody.data;

        const clientIp = requestIp?.split(":")[0];

        const resourceCacheKey = `resource:${host}`;
        let resourceData:
            | {
                  resource: Resource | null;
                  pincode: ResourcePincode | null;
                  password: ResourcePassword | null;
              }
            | undefined = cache.get(resourceCacheKey);

        if (!resourceData) {
            const [result] = await db
                .select()
                .from(resources)
                .leftJoin(
                    resourcePincode,
                    eq(resourcePincode.resourceId, resources.resourceId)
                )
                .leftJoin(
                    resourcePassword,
                    eq(resourcePassword.resourceId, resources.resourceId)
                )
                .where(eq(resources.fullDomain, host))
                .limit(1);

            if (!result) {
                logger.debug("Resource not found", host);
                return notAllowed(res);
            }

            resourceData = {
                resource: result.resources,
                pincode: result.resourcePincode,
                password: result.resourcePassword
            };

            cache.set(resourceCacheKey, resourceData);
        }

        const { resource, pincode, password } = resourceData;

        if (!resource) {
            logger.debug("Resource not found", host);
            return notAllowed(res);
        }

        const { sso, blockAccess } = resource;

        if (blockAccess) {
            logger.debug("Resource blocked", host);
            return notAllowed(res);
        }

        if (
            !resource.sso &&
            !pincode &&
            !password &&
            !resource.emailWhitelistEnabled
        ) {
            logger.debug("Resource allowed because no auth");
            return allowed(res);
        }

        // check the rules
        if (resource.applyRules) {
            const action = await checkRules(
                resource.resourceId,
                clientIp,
                path
            );

            if (action == "ACCEPT") {
                logger.debug("Resource allowed by rule");
                return allowed(res);
            } else if (action == "DROP") {
                logger.debug("Resource denied by rule");
                return notAllowed(res);
            }

            // otherwise its undefined and we pass
        }

        const redirectUrl = `${config.getRawConfig().app.dashboard_url}/auth/resource/${encodeURIComponent(resource.resourceId)}?redirect=${encodeURIComponent(originalRequestURL)}`;

        // check for access token
        let validAccessToken: ResourceAccessToken | undefined;
        if (token) {
            const [accessTokenId, accessToken] = token.split(".");
            const { valid, error, tokenItem } = await verifyResourceAccessToken(
                {
                    resource,
                    accessTokenId,
                    accessToken
                }
            );

            if (error) {
                logger.debug("Access token invalid: " + error);
            }

            if (!valid) {
                if (config.getRawConfig().app.log_failed_attempts) {
                    logger.info(
                        `Resource access token is invalid. Resource ID: ${resource.resourceId}. IP: ${clientIp}.`
                    );
                }
            }

            if (valid && tokenItem) {
                validAccessToken = tokenItem;

                if (!sessions) {
                    return await createAccessTokenSession(
                        res,
                        resource,
                        tokenItem
                    );
                }
            }
        }

        if (!sessions) {
            if (config.getRawConfig().app.log_failed_attempts) {
                logger.info(
                    `Missing resource sessions. Resource ID: ${resource.resourceId}. IP: ${clientIp}.`
                );
            }
            return notAllowed(res);
        }

        const resourceSessionToken =
            sessions[
                `${config.getRawConfig().server.session_cookie_name}${resource.ssl ? "_s" : ""}`
            ];

        if (resourceSessionToken) {
            const sessionCacheKey = `session:${resourceSessionToken}`;
            let resourceSession: any = cache.get(sessionCacheKey);

            if (!resourceSession) {
                const result = await validateResourceSessionToken(
                    resourceSessionToken,
                    resource.resourceId
                );

                resourceSession = result?.resourceSession;
                cache.set(sessionCacheKey, resourceSession);
            }

            if (resourceSession?.isRequestToken) {
                logger.debug(
                    "Resource not allowed because session is a temporary request token"
                );
                if (config.getRawConfig().app.log_failed_attempts) {
                    logger.info(
                        `Resource session is an exchange token. Resource ID: ${resource.resourceId}. IP: ${clientIp}.`
                    );
                }
                return notAllowed(res);
            }

            if (resourceSession) {
                if (pincode && resourceSession.pincodeId) {
                    logger.debug(
                        "Resource allowed because pincode session is valid"
                    );
                    return allowed(res);
                }

                if (password && resourceSession.passwordId) {
                    logger.debug(
                        "Resource allowed because password session is valid"
                    );
                    return allowed(res);
                }

                if (
                    resource.emailWhitelistEnabled &&
                    resourceSession.whitelistId
                ) {
                    logger.debug(
                        "Resource allowed because whitelist session is valid"
                    );
                    return allowed(res);
                }

                if (resourceSession.accessTokenId) {
                    logger.debug(
                        "Resource allowed because access token session is valid"
                    );
                    return allowed(res);
                }

                if (resourceSession.userSessionId && sso) {
                    const userAccessCacheKey = `userAccess:${resourceSession.userSessionId}:${resource.resourceId}`;

                    let isAllowed: boolean | undefined =
                        cache.get(userAccessCacheKey);

                    if (isAllowed === undefined) {
                        isAllowed = await isUserAllowedToAccessResource(
                            resourceSession.userSessionId,
                            resource
                        );

                        cache.set(userAccessCacheKey, isAllowed);
                    }

                    if (isAllowed) {
                        logger.debug(
                            "Resource allowed because user session is valid"
                        );
                        return allowed(res);
                    }
                }
            }
        }

        // At this point we have checked all sessions, but since the access token is valid, we should allow access
        // and create a new session.
        if (validAccessToken) {
            return await createAccessTokenSession(
                res,
                resource,
                validAccessToken
            );
        }

        logger.debug("No more auth to check, resource not allowed");

        if (config.getRawConfig().app.log_failed_attempts) {
            logger.info(
                `Resource access not allowed. Resource ID: ${resource.resourceId}. IP: ${clientIp}.`
            );
        }
        return notAllowed(res, redirectUrl);
    } catch (e) {
        console.error(e);
        return next(
            createHttpError(
                HttpCode.INTERNAL_SERVER_ERROR,
                "Failed to verify session"
            )
        );
    }
}

function notAllowed(res: Response, redirectUrl?: string) {
    const data = {
        data: { valid: false, redirectUrl },
        success: true,
        error: false,
        message: "Access denied",
        status: HttpCode.OK
    };
    logger.debug(JSON.stringify(data));
    return response<VerifyUserResponse>(res, data);
}

function allowed(res: Response) {
    const data = {
        data: { valid: true },
        success: true,
        error: false,
        message: "Access allowed",
        status: HttpCode.OK
    };
    logger.debug(JSON.stringify(data));
    return response<VerifyUserResponse>(res, data);
}

async function createAccessTokenSession(
    res: Response,
    resource: Resource,
    tokenItem: ResourceAccessToken
) {
    const token = generateSessionToken();
    await createResourceSession({
        resourceId: resource.resourceId,
        token,
        accessTokenId: tokenItem.accessTokenId,
        sessionLength: tokenItem.sessionLength,
        expiresAt: tokenItem.expiresAt,
        doNotExtend: tokenItem.expiresAt ? true : false
    });
    const cookieName = `${config.getRawConfig().server.session_cookie_name}`;
    const cookie = serializeResourceSessionCookie(
        cookieName,
        resource.fullDomain!,
        token,
        !resource.ssl
    );
    res.appendHeader("Set-Cookie", cookie);
    logger.debug("Access token is valid, creating new session");
    return response<VerifyUserResponse>(res, {
        data: { valid: true },
        success: true,
        error: false,
        message: "Access allowed",
        status: HttpCode.OK
    });
}

async function isUserAllowedToAccessResource(
    userSessionId: string,
    resource: Resource
): Promise<boolean> {
    const [res] = await db
        .select()
        .from(sessions)
        .leftJoin(users, eq(users.userId, sessions.userId))
        .where(eq(sessions.sessionId, userSessionId));

    const user = res.user;
    const session = res.session;

    if (!user || !session) {
        return false;
    }

    if (
        config.getRawConfig().flags?.require_email_verification &&
        !user.emailVerified
    ) {
        return false;
    }

    const userOrgRole = await db
        .select()
        .from(userOrgs)
        .where(
            and(
                eq(userOrgs.userId, user.userId),
                eq(userOrgs.orgId, resource.orgId)
            )
        )
        .limit(1);

    if (userOrgRole.length === 0) {
        return false;
    }

    const roleResourceAccess = await db
        .select()
        .from(roleResources)
        .where(
            and(
                eq(roleResources.resourceId, resource.resourceId),
                eq(roleResources.roleId, userOrgRole[0].roleId)
            )
        )
        .limit(1);

    if (roleResourceAccess.length > 0) {
        return true;
    }

    const userResourceAccess = await db
        .select()
        .from(userResources)
        .where(
            and(
                eq(userResources.userId, user.userId),
                eq(userResources.resourceId, resource.resourceId)
            )
        )
        .limit(1);

    if (userResourceAccess.length > 0) {
        return true;
    }

    return false;
}

async function checkRules(
    resourceId: number,
    clientIp: string | undefined,
    path: string | undefined
): Promise<"ACCEPT" | "DROP" | undefined> {
    const ruleCacheKey = `rules:${resourceId}`;

    let rules: ResourceRule[] | undefined = cache.get(ruleCacheKey);

    if (!rules) {
        rules = await db
            .select()
            .from(resourceRules)
            .where(eq(resourceRules.resourceId, resourceId));

        cache.set(ruleCacheKey, rules);
    }

    if (rules.length === 0) {
        logger.debug("No rules found for resource", resourceId);
        return;
    }

    let hasAcceptRule = false;

    // First pass: look for DROP rules
    for (const rule of rules) {
        if (
            (clientIp &&
            rule.match == "CIDR" &&
            isIpInCidr(clientIp, rule.value) &&
            rule.action === "DROP") ||
            (path &&
            rule.match == "PATH" &&
            urlGlobToRegex(rule.value).test(path) &&
            rule.action === "DROP")
        ) {
            return "DROP";
        }
        // Track if we see any ACCEPT rules for the second pass
        if (rule.action === "ACCEPT") {
            hasAcceptRule = true;
        }
    }

    // Second pass: only check ACCEPT rules if we found one and didn't find a DROP
    if (hasAcceptRule) {
        for (const rule of rules) {
            if (rule.action !== "ACCEPT") continue;
            
            if (
                (clientIp &&
                rule.match == "CIDR" &&
                isIpInCidr(clientIp, rule.value)) ||
                (path &&
                rule.match == "PATH" &&
                urlGlobToRegex(rule.value).test(path))
            ) {
                return "ACCEPT";
            }
        }
    }

    return;
}

function urlGlobToRegex(pattern: string): RegExp {
    // Remove leading slash if present (we'll add it to the regex pattern)
    pattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;

    // Escape special regex characters except *
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

    // Replace * with regex pattern for any valid URL segment characters
    const regexPattern = escapedPattern.replace(/\*/g, "[a-zA-Z0-9_-]+");

    // Create the final pattern that:
    // 1. Optionally matches leading slash
    // 2. Matches the entire string
    return new RegExp(`^/?${regexPattern}$`);
}
