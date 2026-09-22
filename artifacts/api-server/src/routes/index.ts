import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accountabilityRouter from "./accountability";

const router: IRouter = Router();

router.use(healthRouter);
router.use(accountabilityRouter);

export default router;
