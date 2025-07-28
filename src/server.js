import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors'; 

dotenv.config();

const app = express();
app.use(express.json());

// ✅ CORS Setup
const allowedOrigins = process.env.ALLOWED_DOMAINS?.split(",") || [];
app.use(cors({
    origin: (origin, callback) => {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        } else {
            return callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
}));

// ✅ Test route
app.get('/', (req, res) => {
    res.send('hr Server Running');
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
