import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mcpRouter from "./mcp";
import authRouter from "./auth";
import usersRouter from "./users";
import firmsRouter from "./firms";
import supportRouter from "./support";
import portalRouter from "./portal";
import v1Router from "./v1";
import openapiRouter from "./openapi";
import { bearerAuth, requireBullhornFirm, attachFirmContext } from "../middlewares/bearer-auth.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(openapiRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(firmsRouter);
router.use(supportRouter);
router.use(portalRouter);
router.use(mcpRouter);
router.use("/v1", bearerAuth, requireBullhornFirm, attachFirmContext, v1Router);

export default router;
