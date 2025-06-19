import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
// import { claudecode } from "./shell.js";
const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;

// Configure Vite middleware for React client
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "custom",
});
app.use(vite.middlewares);

// Add middleware to parse JSON requests
app.use(express.json());

// API route for token generation
app.get("/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview",
          voice: "alloy",
          // turn_detection: { silence_duration_ms: 2500 },
        }),
      },
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

const projectRoot = "/Users/murat/Code/recess";

app.post("/claudecode/plan", async (req, res) => {
  // console.log("Plan request body:", req.body);
  const { prompt } = req.body;
  // console.log("plan User prompt:", prompt);
  if (!prompt) {
    console.error("Plan received undefined prompt");
    return res.status(400).json({ error: "No prompt provided" });
  }
  // const plan = await claudecode({ projectRoot, mode: "plan", prompt });
  // console.log("plan:", plan);
  res.json({ plan: "Placeholder plan for testing" });
});

app.post("/claudecode/apply", async (req, res) => {
  console.log("Apply request body:", req.body);
  const { prompt } = req.body;
  console.log("apply User prompt:", prompt);
  if (!prompt) {
    console.error("Apply received undefined prompt");
    return res.status(400).json({ error: "No prompt provided" });
  }
  /*
  const changes = await claudecode({ projectRoot, mode: "apply", prompt });
  console.log("apply:", changes);

  // Extract file changes from Claude's output
  const fileChanges = [];
  const fileRegex = /<file name="([^"]+)">([\s\S]*?)<\/file>/g;
  let match;

  while ((match = fileRegex.exec(changes)) !== null) {
    const [_, filePath, content] = match;
    // Trim leading/trailing whitespace but preserve internal indentation
    console.log("filePath:", filePath);
    fileChanges.push({
      path: filePath,
      content: content.trim() // Use trim() to handle all whitespace consistently
    });
  }

  // Generate git-style diffs
  const diffs = [];
  for (const change of fileChanges) {
    const fullPath = path.join(projectRoot, change.path);
    let originalContent = '';
    
    try {
      console.log("fullPath:", fullPath);
      if (fs.existsSync(fullPath)) {
        originalContent = fs.readFileSync(fullPath, 'utf8');
      } else {
        console.log(`Creating new file: ${change.path}`);
      }
    } catch (err) {
      console.warn(`Could not read original file: ${fullPath}`, err);
    }

    // Create unified diff with proper headers and context
    const diffResult = createPatch(
      change.path,
      originalContent,
      change.content,
      'Original',
      'Modified',
      { context: 3 } // Show 3 lines of context around changes
    );

    diffs.push(diffResult);
  }

  // Combine all diffs into a single patch with proper spacing
  const combinedDiff = diffs.join('\n\n'); // Add extra newline between file diffs
  */
  res.json({ changes: "Placeholder changes for testing" });
});

// Render the React client
app.use("*", async (req, res, next) => {
  const url = req.originalUrl;

  try {
    const template = await vite.transformIndexHtml(
      url,
      fs.readFileSync("./client/index.html", "utf-8"),
    );
    const { render } = await vite.ssrLoadModule("./client/entry-server.jsx");
    const appHtml = await render(url);
    const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);
    res.status(200).set({ "Content-Type": "text/html" }).end(html);
  } catch (e) {
    vite.ssrFixStacktrace(e);
    next(e);
  }
});

app.listen(port, () => {
  console.log(`Express server running on *:${port}`);
});
