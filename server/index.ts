import express from "express";
import type { Request, Response } from "express";
import { handleAnalyzeDeal } from "./analyze-deal";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for Vercel
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// API Routes
app.post("/api/analyze-deal", handleAnalyzeDeal);

// Health check
app.get("/api/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve static files from dist/public in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static("dist/public"));
  app.get("*", (req: Request, res: Response) => {
    res.sendFile("index.html", { root: "dist/public" });
  });
}

// Start server
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
