/**
 * One-off utility: uploads ../base/node-js and ../base/python to
 * base/node-js and base/python in your R2/S3 bucket, so init-service has
 * something to copy from on POST /project. Reads credentials from this
 * service's own .env (never hardcode them here) - the same S3_BUCKET /
 * S3_ENDPOINT / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY it uses in
 * production. Re-run any time to re-sync after editing the local templates.
 *
 * Usage: cd init-service && node seed-templates.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { S3 } = require("aws-sdk");

const required = ["S3_BUCKET", "S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`Missing ${key} in init-service/.env - fill it in first.`);
        process.exit(1);
    }
}

const s3 = new S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.S3_ENDPOINT,
    s3ForcePathStyle: true,
});

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

async function uploadTemplate(localDir, bucketPrefix) {
    if (!fs.existsSync(localDir)) {
        console.error(`Local template folder not found: ${localDir}`);
        return;
    }
    const files = walk(localDir);
    for (const file of files) {
        const relativeKey = path.relative(localDir, file).split(path.sep).join("/");
        const key = `${bucketPrefix}/${relativeKey}`;
        await s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: fs.readFileSync(file),
        }).promise();
        console.log(`Uploaded ${key}`);
    }
}

(async () => {
    await uploadTemplate(path.join(__dirname, "..", "base", "node-js"), "base/node-js");
    await uploadTemplate(path.join(__dirname, "..", "base", "python"), "base/python");
    console.log("Done.");
})().catch((err) => {
    console.error("Upload failed:", err);
    process.exit(1);
});
