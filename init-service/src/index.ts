import express from "express";
import dotenv from "dotenv"
import cors from "cors";
dotenv.config()
import { randomUUID } from "crypto";
import { copyS3Folder } from "./aws";
import { requireAuth, signToken } from "./auth";
import { createProject, getProject } from "./db";
import { rateLimit } from "./rateLimit";

const app = express();
app.use(express.json());
app.use(cors())

// Bootstraps an anonymous, device-bound identity - there's no login/password
// in this project. The frontend calls this once, caches the token, and sends
// it as a bearer token on every subsequent request.
app.post("/auth/session", (req, res) => {
    const userId = randomUUID();
    const token = signToken(userId);
    res.send({ token, userId });
});

app.post("/project", requireAuth, rateLimit, async (req, res) => {
    const { replId, language } = req.body;

    if (!replId) {
        res.status(400).send("Bad request");
        return;
    }

    if (getProject(replId)) {
        res.status(409).send("replId already taken");
        return;
    }

    await copyS3Folder(`base/${language}`, `code/${replId}`);
    createProject(replId, req.userId as string);

    res.send("Project created");
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
    console.log(`listening on *:${port}`);
});
