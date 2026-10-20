import express from "express";
import dotenv from "dotenv"
import cors from "cors";
dotenv.config()
import { randomUUID } from "crypto";
import { copyS3Folder } from "./aws";
import { requireAuth, signToken } from "./auth";
import { createProject, deleteProject, getProject } from "./db";
import { rateLimit } from "./rateLimit";
import { ALLOWED_ORIGINS } from "./corsOrigins";
import { isValidReplId, isValidLanguage, ALLOWED_LANGUAGES } from "./validators";

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
app.use(cors({ origin: ALLOWED_ORIGINS }))

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

    if (!isValidReplId(replId)) {
        res.status(400).send({ message: "Invalid replId: must match ^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$" });
        return;
    }
    if (!isValidLanguage(language)) {
        res.status(400).send({ message: `Invalid language: must be one of ${ALLOWED_LANGUAGES.join(", ")}` });
        return;
    }

    if (getProject(replId)) {
        res.status(409).send("replId already taken");
        return;
    }

    // Reserve the row before copying, not after - a crash/restart between
    // the two used to leave a S3 copy with no ownership record at all. If
    // the copy below fails, the reservation is rolled back so the replId
    // isn't left permanently "taken" with nothing behind it.
    createProject(replId, req.userId as string);
    try {
        await copyS3Folder(`base/${language}`, `code/${replId}`);
        res.send("Project created");
    } catch (err) {
        // An S3 error here (bad credentials, network blip, unknown language
        // folder) must not crash the whole process for every other user -
        // just fail this one request.
        console.error(`Failed to create project ${replId}:`, err);
        deleteProject(replId);
        res.status(500).send("Failed to create project");
    }
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
    console.log(`listening on *:${port}`);
});
