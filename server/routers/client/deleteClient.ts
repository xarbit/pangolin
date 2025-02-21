import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "@server/db";
import { newts, newtSessions, sites } from "@server/db/schema";
import { eq } from "drizzle-orm";
import response from "@server/lib/response";
import HttpCode from "@server/types/HttpCode";
import createHttpError from "http-errors";
import logger from "@server/logger";
import { deletePeer } from "../gerbil/peers";
import { fromError } from "zod-validation-error";
import { sendToClient } from "../ws";

const deleteClientSchema = z
    .object({
        siteId: z.string().transform(Number).pipe(z.number().int().positive())
    })
    .strict();

export async function deleteSite(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> {
    try {
        const parsedParams = deleteClientSchema.safeParse(req.params);
        if (!parsedParams.success) {
            return next(
                createHttpError(
                    HttpCode.BAD_REQUEST,
                    fromError(parsedParams.error).toString()
                )
            );
        }

        const { siteId } = parsedParams.data;

        const [site] = await db
            .select()
            .from(sites)
            .where(eq(sites.siteId, siteId))
            .limit(1);

        if (!site) {
            return next(
                createHttpError(
                    HttpCode.NOT_FOUND,
                    `Site with ID ${siteId} not found`
                )
            );
        }

        await db.transaction(async (trx) => {
            if (site.pubKey) {
                if (site.type == "wireguard") {
                    await deletePeer(site.exitNodeId!, site.pubKey);
                } else if (site.type == "newt") {
                    // get the newt on the site by querying the newt table for siteId
                    const [deletedNewt] = await trx
                        .delete(newts)
                        .where(eq(newts.siteId, siteId))
                        .returning();
                    if (deletedNewt) {
                        const payload = {
                            type: `newt/terminate`,
                            data: {}
                        };
                        sendToClient(deletedNewt.newtId, payload);

                        // delete all of the sessions for the newt
                        await trx
                            .delete(newtSessions)
                            .where(eq(newtSessions.newtId, deletedNewt.newtId));
                    }
                }
            }

            await trx.delete(sites).where(eq(sites.siteId, siteId));
        });

        return response(res, {
            data: null,
            success: true,
            error: false,
            message: "Site deleted successfully",
            status: HttpCode.OK
        });
    } catch (error) {
        logger.error(error);
        return next(
            createHttpError(HttpCode.INTERNAL_SERVER_ERROR, "An error occurred")
        );
    }
}
