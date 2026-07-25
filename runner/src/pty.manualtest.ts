// Manual repro/verification script for the TerminalManager session-cleanup bug.
// Run with: npm run test:pty  (from runner/)
//
// Scenario: create two terminal sessions, let one exit naturally (the path
// that used to delete by the wrong key), and confirm:
//   1. the exited session is fully removed from tracking
//   2. its OS process is actually dead (no orphaned PTY)
//   3. the other session is untouched and still tracked
import os from "os";
import { TerminalManager } from "./pty";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
    try {
        // Signal 0 does no killing, it just probes whether the pid exists.
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        if (err.code === "EPERM") return true; // exists, just not ours to signal
        return false; // ESRCH (no such process) or anything else -> treat as dead
    }
}

let failures = 0;

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS - ${message}`);
    } else {
        console.log(`  FAIL - ${message}`);
        failures++;
    }
}

async function main() {
    // Real pods always use /workspace; this script runs outside a pod, so it
    // points at a scratch dir instead (TerminalManager defaults to /workspace
    // when no cwd is given).
    const manager = new TerminalManager(os.tmpdir());

    console.log("Creating two terminal sessions: term-a, term-b");
    const termA = manager.createPty("term-a", "test-repl", () => {});
    const termB = manager.createPty("term-b", "test-repl", () => {});
    const pidA = termA.pid;
    const pidB = termB.pid;

    await sleep(300);
    assert(manager.has("term-a"), "term-a is tracked right after creation");
    assert(manager.has("term-b"), "term-b is tracked right after creation");

    console.log("\nExiting term-a naturally (simulates user typing `exit`)");
    termA.write("exit\r");

    // Give the shell time to exit and the 'exit' handler to fire.
    await sleep(1000);

    assert(!manager.has("term-a"), "term-a removed from tracking after natural exit");
    assert(!isProcessAlive(pidA), `term-a OS process (pid ${pidA}) is no longer running`);
    assert(manager.has("term-b"), "term-b is still tracked after term-a exited");
    assert(isProcessAlive(pidB), `term-b OS process (pid ${pidB}) is still running`);

    console.log("\nExplicitly clearing term-b");
    manager.clear("term-b");
    await sleep(300);

    assert(!manager.has("term-b"), "term-b removed from tracking after clear()");
    assert(!isProcessAlive(pidB), `term-b OS process (pid ${pidB}) is no longer running`);

    console.log("\nClearing an already-removed/unknown id does not throw");
    let threw = false;
    try {
        manager.clear("term-a");
        manager.clear("does-not-exist");
    } catch {
        threw = true;
    }
    assert(!threw, "clear() on a missing session id is a safe no-op");

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
