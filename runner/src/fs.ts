import fs from "fs";
import path from "path";

export const WORKSPACE_DIR = "/workspace";

interface File {
    type: "file" | "dir";
    name: string;
}

// Resolves a caller-supplied relative path against /workspace and rejects
// anything that would escape it (e.g. "../../etc/passwd") - without this,
// fetchDir/fetchContent/updateContent let a malicious client read or write
// anywhere the runner process can reach on disk, not just this project's
// own files.
//
// Uses path.posix.join, not path.resolve: the existing wire protocol
// already sends paths with a leading "/" (e.g. "/index.js" - see
// fetchDir's own `${baseDir}/${file.name}`), and path.resolve treats an
// absolute-looking second argument as replacing the first entirely, which
// would reject every normal request. join instead treats it as just
// another path segment (so "/index.js" safely lands at
// "/workspace/index.js"), while still normalizing ".." sequences, which is
// what the startsWith check below actually needs to catch.
//
// Also uses path.posix explicitly (not the OS-dependent path module) since
// this only ever runs inside a Linux container, regardless of what
// platform runs its tests.
export function resolveInWorkspace(rel: string): string {
    const resolved = path.posix.join(WORKSPACE_DIR, rel);
    if (resolved !== WORKSPACE_DIR && !resolved.startsWith(WORKSPACE_DIR + "/")) {
        throw new Error(`Path escapes workspace: ${rel}`);
    }
    return resolved;
}

export const fetchDir = (dir: string, baseDir: string): Promise<File[]>  => {
    return new Promise((resolve, reject) => {
        fs.readdir(dir, { withFileTypes: true }, (err, files) => {
            if (err) {
                reject(err);
            } else {
                resolve(files.map(file => ({ type: file.isDirectory() ? "dir" : "file", name: file.name, path: `${baseDir}/${file.name}`  })));
            }
        });
    });
}

export const fetchFileContent = (file: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        fs.readFile(file, "utf8", (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    })
}

export const saveFile = async (file: string, content: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        fs.writeFile(file, content, "utf8", (err) => {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}
