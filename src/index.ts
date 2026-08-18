import "./types";
import http from "http";
import express from "express";
import cors from "cors";
import compression from "compression";
import { config } from "./config";
import authRouter from "./routes/auth";
import jobsRouter from "./routes/jobs";
import responsesRouter from "./routes/responses";
import districtsRouter from "./routes/districts";
import pincodesRouter from "./routes/pincodes";
import adminRouter from "./routes/admin";
import aiRouter from "./routes/ai";
import chatRouter from "./routes/chat";
import pushRouter from "./routes/push";
import ratingsRouter from "./routes/ratings";
import feedbackRouter from "./routes/feedback";
import agentRouter from "./routes/agent";
import profileRouter from "./routes/profile";
import activitiesRouter from "./routes/activities";
import { errorHandler } from "./middleware/error";
import { requestLogger } from "./middleware/request-logger";
import { attachRealtime } from "./lib/realtime";
import { pool } from "./db/pool";
import { SCHEMA_DDL } from "./db/schema";
import { logEvent } from "./lib/events";

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.set("trust proxy", 1);
// gzip every response over 1 KB — cuts outbound bandwidth ~70% on JSON.
app.use(compression({ threshold: 1024 }));
app.use(express.json());
app.use(requestLogger);

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
app.use("/api/chat", chatRouter);
app.use("/api/push", pushRouter);
app.use("/api/ratings", ratingsRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/agent", agentRouter);
app.use("/api/profile", profileRouter);
app.use("/api/activities", activitiesRouter);

app.use(errorHandler);

// HTTP server shared by Express and the WebSocket (chat) server.
const server = http.createServer(app);
attachRealtime(server);

// Self-migrate on boot — the schema DDL is idempotent (every CREATE / ALTER
// uses `if not exists`), so each deploy quietly applies any new tables.
pool
  .query(SCHEMA_DDL)
  .then(() => {
    console.log("✓ schema in sync");
    logEvent({ kind: "system", message: "schema in sync" });
  })
  .catch((e) => {
    console.error("Schema sync failed:", e);
    logEvent({ kind: "system", status: "error", message: "schema sync failed", error: String(e?.message ?? e) });
  });

server.listen(config.port, () => {
  console.log(`Velai API running → http://localhost:${config.port}`);
  logEvent({ kind: "system", message: `boot on port ${config.port}` });
});
