import express from "express";
import dotenv from "dotenv"
import cors from "cors";
dotenv.config()
import { randomUUID } from "crypto";
import { copyS3Folder } from "./aws";
import { requireAuth, signToken } from "./auth";
import { createProject, getProject } from "./db";
import { rateLimit } from "./rateLimit";

// Express 4 doesn't catch a rejected async route handler for you - an
// unguarded await that throws becomes an unhandled rejection, which Node
// terminates the whole process over by default. Found this the hard way in
// runner (see runner/src/index.ts's comment); every route below now has its
// own try/catch too, but this is the last line of defense against the next
// one that doesn't.
process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection] swallowed to avoid crashing the process:", reason);
});

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

    try {
        await copyS3Folder(`base/${language}`, `code/${replId}`);
        createProject(replId, req.userId as string);
        res.send("Project created");
    } catch (err) {
        // An S3 error here (bad credentials, network blip, unknown language
        // folder) must not crash the whole process for every other user -
        // just fail this one request.
        console.error(`Failed to create project ${replId}:`, err);
        res.status(500).send("Failed to create project");
    }
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
    console.log(`listening on *:${port}`);
});
