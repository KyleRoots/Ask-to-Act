import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mcpRouter from "./mcp";
import authRouter from "./auth";
import usersRouter from "./users";
import v1Router from "./v1";
import { bearerAuth } from "../middlewares/bearer-auth.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(mcpRouter);
router.use("/v1", bearerAuth, v1Router);

export default router;
