import { serve } from "bun";
import App from "./index.html";
import mime from "mime-types";
import { Command } from 'commander';
import { TerminalController } from '../controller2';

const program = new Command();

program
    .option('-p, --port <number>', 'port to listen on', '3000')
    .parse(process.argv);

const options = program.opts();
const port = parseInt(options.port);

// Environment variables
const apiKey = process.env.OPENAI_API_KEY;
const projectRoot = "/Users/murat/Code/recess";

// Global terminal controller instance
let terminalController: TerminalController | null = null;

// Initialize terminal controller
async function initializeTerminalController() {
    if (terminalController) {
        await terminalController.dispose();
    }
    
    terminalController = new TerminalController({
        sessionNamePrefix: 'maid-1',
        idleTimeoutMs: 2000
    });

    terminalController.on('error', (error) => {
        console.error('Terminal controller error:', error);
    });

    terminalController.on('ready', () => {
        console.log('Terminal controller ready');
    });

    return new Promise<void>((resolve) => {
        terminalController!.on('ready', () => {
            resolve();
        });
    });
}

// Wait for terminal to be idle and return current state
function waitForTerminalIdle(): Promise<string> {
    return new Promise((resolve) => {
        if (!terminalController) {
            resolve('');
            return;
        }

        const onIdle = async () => {
            terminalController!.off('idle', onIdle);
            const content = await terminalController!.getCurrentContent();
            resolve(content);
        };

        terminalController.on('idle', onIdle);
    });
}

// Utility function for JSON responses
const jsonResponse = (data: any, status: number = 200) => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
};

// Initialize terminal controller on startup
initializeTerminalController().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    if (terminalController) {
        await terminalController.dispose();
    }
    process.exit(0);
});

const server = serve({
    port,
    routes: {
        // PUT SPECIFIC ROUTES FIRST - they need to be matched before wildcard routes
        "/terminal/type": async (req: Request) => {
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 });
            }

            if (!terminalController) {
                return jsonResponse({ error: "Terminal controller not initialized" }, 500);
            }

            try {
                const body = await req.json();
                const { text } = body;
                
                if (!text) {
                    return jsonResponse({ error: "Missing 'text' parameter" }, 400);
                }

                // Send the text to terminal
                await terminalController.sendKeys(text);
                
                // Wait for terminal to be idle and get the state
                const terminalState = await waitForTerminalIdle();
                
                return jsonResponse({ 
                    success: true, 
                    terminalState 
                });
            } catch (error) {
                console.error("Terminal type error:", error);
                return jsonResponse({ error: "Failed to send text to terminal" }, 500);
            }
        },
        "/terminal/press_key": async (req: Request) => {
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 });
            }

            if (!terminalController) {
                return jsonResponse({ error: "Terminal controller not initialized" }, 500);
            }

            try {
                const body = await req.json();
                const { key } = body;
                
                if (!key) {
                    return jsonResponse({ error: "Missing 'key' parameter" }, 400);
                }

                // Handle special keys
                if (key === "Enter") {
                    await terminalController.pressEnter();
                } else {
                    await terminalController.sendKeys(key);
                }
                
                // Wait for terminal to be idle and get the state
                const terminalState = await waitForTerminalIdle();
                
                return jsonResponse({ 
                    success: true, 
                    terminalState 
                });
            } catch (error) {
                console.error("Terminal key press error:", error);
                return jsonResponse({ error: "Failed to send key to terminal" }, 500);
            }
        },
        "/terminal/submitText": async (req: Request) => {
            // This endpoint combines typing text and pressing Enter, useful for sending full commands.
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 });
            }

            if (!terminalController) {
                return jsonResponse({ error: "Terminal controller not initialized" }, 500);
            }

            try {
                const body = await req.json();
                const { text } = body;

                if (!text) {
                    return jsonResponse({ error: "Missing 'text' parameter" }, 400);
                }

                // Send the text and then press Enter.
                await terminalController.sendKeys(text);
                await terminalController.pressEnter();

                // Wait for terminal to finish processing and capture its state.
                const terminalState = await waitForTerminalIdle();

                return jsonResponse({
                    success: true,
                    terminalState,
                });
            } catch (error) {
                console.error("Terminal submitText error:", error);
                return jsonResponse({ error: "Failed to submit text to terminal" }, 500);
            }
        },
        "/terminal/command": async (req: Request) => {
            if (req.method !== "POST") {
                return new Response("Method not allowed", { status: 405 });
            }

            if (!terminalController) {
                return jsonResponse({ error: "Terminal controller not initialized" }, 500);
            }

            try {
                const body = await req.json();
                const { command } = body;
                
                if (!command) {
                    return jsonResponse({ error: "Missing 'command' parameter" }, 400);
                }

                // Send the command to terminal
                await terminalController.sendCommand(command);
                
                // Wait for terminal to be idle and get the state
                const terminalState = await waitForTerminalIdle();
                
                return jsonResponse({ 
                    success: true, 
                    terminalState 
                });
            } catch (error) {
                console.error("Terminal command error:", error);
                return jsonResponse({ error: "Failed to send command to terminal" }, 500);
            }
        },
        "/terminal/get_terminal_state": async (req: Request) => {

            if (!terminalController) {
                return jsonResponse({ error: "Terminal controller not initialized" }, 500);
            }

            try {
                const terminalState = await terminalController.getCurrentContent();
                return jsonResponse({ terminalState });
            } catch (error) {
                console.error("Terminal state error:", error);
                return jsonResponse({ error: "Failed to get terminal state" }, 500);
            }
        },
        "/token": async (req: Request) => {
            if (req.method !== "GET") {
                return new Response("Method not allowed", { status: 405 });
            }

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
                            instructions: "You are a technical assistant, you speak concisely and to the point without filler words or niceties.",
                            speed: 1.5
                            // turn_detection: { silence_duration_ms: 2500 },
                        })
                    }
                );

                const data = await response.json();
                return jsonResponse(data);
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
    
    fetch(req, server) {
        if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
    },
    websocket: {
        message(ws, message) {
            console.log('WebSocket message received:', message);
        },
        open(ws) {
            console.log('WebSocket connection opened');
            // Subscribe this connection to terminal updates
            if (terminalController) {
                terminalController.addWebSocketClient(ws);
                // Send current terminal state to new connection
                terminalController.getCurrentContent().then(content => {
                    if (content) {
                        ws.send(JSON.stringify({
                            type: 'terminal_state',
                            data: content
                        }));
                    }
                }).catch(err => {
                    console.error('Error sending initial terminal state:', err);
                });
            }
        },
        close(ws, code, message) {
            console.log('WebSocket connection closed:', code, message);
            // Unsubscribe this connection from terminal updates
            if (terminalController) {
                terminalController.removeWebSocketClient(ws);
            }
        },
        drain(ws) {
            // the socket is ready to receive more data
        },
    },
});

console.log("Listening on :" + port);
