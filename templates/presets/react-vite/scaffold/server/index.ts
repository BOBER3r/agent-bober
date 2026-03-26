import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3001;

// -- Middleware ----------------------------------------------------------
app.use(express.json());

// -- API Routes ----------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// -- Static Serving (production) -----------------------------------------
// In production, serve the built Vite client from dist/client.
if (process.env.NODE_ENV === "production") {
  const clientDist = path.resolve(__dirname, "../client");
  app.use(express.static(clientDist));

  // SPA fallback: serve index.html for any non-API route.
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// -- Start ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

export default app;
