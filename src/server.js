// hr-service/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import hrRoutes from "./routes/hr.routes.js";
import client from "prom-client";

dotenv.config();
const app = express();
// Create a registry
const register = new client.Registry();
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

// HR routes
app.use("/employees", hrRoutes);

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/", (req, res) => res.json({message: "HR Service Running 🏢"}));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
