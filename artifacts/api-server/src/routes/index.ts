import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mcpRouter from "./mcp";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth/bullhorn", authRouter);
router.use(mcpRouter);

export default router;
