import "./types";
import express from "express";
import cors from "cors";
import { config } from "./config";
import authRouter from "./routes/auth";
import jobsRouter from "./routes/jobs";
import responsesRouter from "./routes/responses";
import districtsRouter from "./routes/districts";
import pincodesRouter from "./routes/pincodes";
import adminRouter from "./routes/admin";
import aiRouter from "./routes/ai";
import { errorHandler } from "./middleware/error";

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.set("trust proxy", 1);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "velai-api" });
});

app.use("/api/auth", authRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/responses", responsesRouter);
app.use("/api/districts", districtsRouter);
app.use("/api/pincodes", pincodesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/ai", aiRouter);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Velai API running → http://localhost:${config.port}`);
});
