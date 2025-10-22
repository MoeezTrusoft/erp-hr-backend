// hr-service/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import hrRoutes from "./routes/hr.routes.js";

dotenv.config();
const app = express();

app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

// HR routes
app.use("/employees", hrRoutes);

app.get("/", (req, res) => res.json({message: "HR Service Running"}));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`HR Service running on port ${PORT}`));
