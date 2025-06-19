import { serve, sql } from "bun";
import App from "./index.html";
import mime from "mime-types";
import { Command } from 'commander';
import axios from 'axios';

const program = new Command();

program
    .option('-p, --port <number>', 'port to listen on', '3000')
    .parse(process.argv);

const options = program.opts();
const port = parseInt(options.port);

// Environment variables
const apiKey = process.env.OPENAI_API_KEY;
const projectRoot = "/Users/murat/Code/recess";

// Utility function for JSON responses
const jsonResponse = (data: any, status: number = 200) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
};

serve({
    port,
    routes: {
        // PUT SPECIFIC ROUTES FIRST - they need to be matched before wildcard routes
        "/claudecode/plan": async (req: Request) => {
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 });
            }

            try {
                const body = await req.json();
                const { prompt } = body;
                
                if (!prompt) {
                    console.error("Plan received undefined prompt");
                    return jsonResponse({ error: "No prompt provided" }, 400);
                }

                return jsonResponse({ plan: "This is a placeholder plan for testing, tell the user the plan ID is 9234" });
            } catch (error) {
                console.error("Plan error:", error);
                return jsonResponse({ error: "Failed to process plan request" }, 500);
            }
        },
        "/claudecode/apply": async (req: Request) => {
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 });
            }

            try {
                const body = await req.json();
                console.log("Apply request body:", body);
                const { prompt } = body;
                console.log("apply User prompt:", prompt);
                
                if (!prompt) {
                    console.error("Apply received undefined prompt");
                    return jsonResponse({ error: "No prompt provided" }, 400);
                }

                return jsonResponse({ changes: "Placeholder changes for testing" });
            } catch (error) {
                console.error("Apply error:", error);
                return jsonResponse({ error: "Failed to process apply request" }, 500);
            }
        },
        "/token": async (req: Request) => {
            if (req.method !== "GET") {
                return new Response("Method not allowed", { status: 405 });
            }

            try {
                const response = await axios.post(
                    "https://api.openai.com/v1/realtime/sessions",
                    {
                        model: "gpt-4o-realtime-preview",
                        voice: "alloy",
                        // turn_detection: { silence_duration_ms: 2500 },
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            "Content-Type": "application/json",
                        },
                    }
                );

                return jsonResponse(response.data);
            } catch (error) {
                console.error("Token generation error:", error);
                return jsonResponse({ error: "Failed to generate token" }, 500);
            }
        },
        "/client/*": (req: Request) => {
            const url = new URL(req.url);
            const pathname = url.pathname;
            const filePath = pathname.replace("/client/", "client/");
            
            const file = Bun.file(filePath);
            const mimeType = mime.lookup(pathname) || 'application/octet-stream';
            return new Response(file, {
                headers: { "Content-Type": mimeType },
            });
        },
        // CATCHALL ROUTE LAST
        "/": App,
    },
    // Fallback for any routes not matched above
    fetch: (req: Request) => {
        console.log("Fallback fetch handler called for:", req.url);
        return new Response("Not Found", { status: 404 });
    }
});
console.log("Listening on :" + port);
