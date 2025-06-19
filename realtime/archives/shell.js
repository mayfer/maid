import { spawn } from "child_process";

async function runClaudeCommand(prompt, workingDir, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
        console.log("Running Claude command:", prompt, "in", workingDir);
        
        // Escape the prompt to avoid shell interpretation issues
        const escapedPrompt = JSON.stringify(prompt);
        
        const child = spawn("claude", ["-p", escapedPrompt], {
            cwd: workingDir,
            shell: true,
            stdio: ["pipe", "pipe", "pipe"]
        });
        console.log("Claude process spawned");

        child.stdin.end();

        let output = "";

        child.stdout.on("data", (data) => {
            output += data.toString();
            console.log("Claude output:", data.toString());
        });

        child.stderr.on("data", (data) => {
            console.error("Error:", data.toString());
        });

        const timeout = setTimeout(() => {
            console.log("Process timed out, killing...");
            child.kill();
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.on("close", (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });

        child.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

export async function claudecode({ projectRoot, mode, prompt }) {

    const mode_instructions = {
        "plan": `Provide a plan for the changes you're going to make, only list which files you'll need to modify and what functions you'll need to change. You don't need full implementation at this step.`,
        "apply": `When you're done, output all changes you were going to apply as regular text output so i can see in print mode. mark files in xml like
<file name="folder/file.ts">
... code ...
</file>
where filenames are relative to the project root.`
    }

    const instructions = mode_instructions[mode];
    const fullPrompt = `${prompt}\n\n${instructions}`;

    try {
        const output = await runClaudeCommand(fullPrompt, projectRoot);
        console.log("Final Claude output:", output);
        return output;
    } catch (error) {
        console.error("Failed to run Claude:", error);
        throw error;
    }
}

