#!/usr/bin/env ts-node

import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Represents the high-level activity state of the managed terminal.
 */
export type ControllerState = 'idle' | 'busy' | 'waiting_input';

export interface TerminalControllerOptions {
    /**
     * How long (ms) the screen must remain unchanged before we emit an `idle` event.
     * Defaults to 2000 ms.
     */
    idleTimeoutMs?: number;
    /**
     * Optional session name prefix. If not provided, will use timestamp.
     */
    sessionNamePrefix?: string;
}

/**
 * TerminalController is a small wrapper around tmux that creates an isolated
 * session and provides simple programmatic control over it.
 *
 * Usage example:
 *
 *   const ctrl = new TerminalController();
 *   ctrl.on('idle', () => console.log('session is idle'));
 *   await ctrl.sendCommand('ls -la');
 *   const listing = await ctrl.runCommand('cat README.md');
 */
export class TerminalController extends EventEmitter {
    private readonly sessionName: string;
    private readonly idleTimeoutMs: number;

    private lastContent = '';
    private lastStateChange = Date.now();
    private monitoring = false;
    private webSocketClients: Set<any> = new Set();

    constructor(private readonly options: TerminalControllerOptions = {}) {
        super();
        const prefix = options.sessionNamePrefix || 'terminal';
        this.sessionName = `${prefix}`;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 2000;

        // Fire-and-forget init sequence.
        this.initialise().catch(err => this.emit('error', err));
    }

    /* ----------------------- Public API ----------------------- */

    /**
     * Send an arbitrary key sequence (without automatic <Enter>).
     */
    async sendKeys(keys: string): Promise<void> {
        await this.tmuxCommand(`send-keys -t ${this.sessionName} ${this.quote(keys)}`);
    }

    /**
     * Press the Enter key.
     */
    async pressEnter(): Promise<void> {
        await this.tmuxCommand(`send-keys -t ${this.sessionName} Enter`);
    }

    /**
     * Convenience helper: send a full shell command followed by <Enter>.
     */
    async sendCommand(cmd: string): Promise<void> {
        await this.sendKeys(cmd);
        await this.pressEnter();
    }

    /**
     * Run a shell command and resolve with the output produced by that command.
     * Note: this does a naive diff between screen captures *before* and *after*
     * execution. For most simple commands (e.g. `ls`, `pwd`) this is sufficient.
     */
    async runCommand(cmd: string): Promise<string> {
        const before = await this.capturePane();
        await this.sendCommand(cmd);
        await this.waitForIdle();
        const after = await this.capturePane();
        return this.extractDiff(before, after).trim();
    }

    /**
     * Get the current screen content.
     */
    async getCurrentContent(): Promise<string> {
        return await this.capturePane();
    }

    /**
     * Get the session name for this controller.
     */
    getSessionName(): string {
        return this.sessionName;
    }

    /**
     * Force emit current terminal state (useful for WebSocket connections)
     */
    async emitCurrentState(): Promise<void> {
        const content = await this.capturePane();
        this.emit('output', content);
    }

    /**
     * Add a WebSocket client to receive terminal updates
     */
    addWebSocketClient(ws: any): void {
        this.webSocketClients.add(ws);
    }

    /**
     * Remove a WebSocket client from terminal updates
     */
    removeWebSocketClient(ws: any): void {
        this.webSocketClients.delete(ws);
    }

    /**
     * Broadcast terminal state to all connected WebSocket clients
     */
    private broadcastToWebSockets(content: string): void {
        const message = JSON.stringify({
            type: 'terminal_state',
            data: content
        });

        this.webSocketClients.forEach(ws => {
            try {
                ws.send(message);
            } catch (error) {
                console.error('Error sending WebSocket message:', error);
                // Remove failed connection
                this.webSocketClients.delete(ws);
            }
        });
    }

    /**
     * Gracefully dispose the controller and kill the underlying tmux session.
     */
    async dispose(): Promise<void> {
        this.monitoring = false;
        // Close all WebSocket connections
        this.webSocketClients.clear();
        try {
            await this.tmuxCommand(`kill-session -t ${this.sessionName}`);
        } catch (err) {
            // Ignore if already killed.
        }
    }

    /* ----------------------- Initialisation ----------------------- */

    private async initialise(): Promise<void> {
        await this.startTmuxServer();

        // Create brand-new session.
        try {
            // If somehow a session with the same name exists, nuke it first.
            const existing = await this.tmuxCommand('list-sessions -F "#{session_name}"', { ignoreErrors: true });
            if (existing.split('\n').includes(this.sessionName)) {
                await this.tmuxCommand(`kill-session -t ${this.sessionName}`);
            }
            await this.tmuxCommand(`new-session -d -s ${this.sessionName}`);
        } catch (err) {
            throw new Error(`Unable to create tmux session: ${String(err)}`);
        }

        // Session is ready - emit event so outer loop can start whatever it wants
        this.emit('ready');

        // Begin monitor loop.
        this.monitoring = true;
        this.monitorLoop();
    }

    /* ----------------------- Monitor Loop ----------------------- */

    private async monitorLoop(): Promise<void> {
        while (this.monitoring) {
            const content = await this.capturePane();
            if (content !== this.lastContent) {
                this.emit('output', content);
                this.broadcastToWebSockets(content); // Broadcast to WebSocket clients
                this.lastContent = content;
                this.lastStateChange = Date.now();
                this.emitState('busy');
            } else if (Date.now() - this.lastStateChange >= this.idleTimeoutMs) {
                this.emitState('idle');
            }
            await this.sleep(50); // Reduced sleep time for more responsive updates
        }
    }

    private currentState: ControllerState = 'busy';
    private emitState(state: ControllerState) {
        if (state !== this.currentState) {
            this.currentState = state;
            this.emit(state);
        }
    }

    /* ----------------------- Helper Utilities ----------------------- */

    private async waitForIdle(): Promise<void> {
        return new Promise(resolve => {
            const onIdle = () => {
                this.off('idle', onIdle);
                resolve();
            };
            this.on('idle', onIdle);
        });
    }

    private async startTmuxServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn('tmux', ['start-server']);
            proc.on('error', reject);
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`tmux start-server exited with code ${code}`));
            });
        });
    }

    private tmuxCommand(command: string, opts: { ignoreErrors?: boolean } = {}): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                const out = execSync(`tmux ${command}`, { encoding: 'utf8' }).toString().trim();
                resolve(out);
            } catch (err) {
                if (opts.ignoreErrors) resolve('');
                else reject(err);
            }
        });
    }

    private async capturePane(): Promise<string> {
        try {
            return await this.tmuxCommand(`capture-pane -t ${this.sessionName} -p`);
        } catch (err) {
            return '';
        }
    }

    private extractDiff(before: string, after: string): string {
        if (!before) return after;
        const idx = after.indexOf(before);
        return idx === -1 ? after : after.slice(idx + before.length);
    }

    private quote(str: string): string {
        return `'${str.replace(/'/g, "'\\''")}'`;
    }

    private sleep(ms: number) {
        return new Promise(res => setTimeout(res, ms));
    }
}

/* ======================== MAIN CONTROL LOOP ======================== */

// Import dependencies for LLM and actions (same as original controller)
const { promptLLM } = require('./llm/chat_api');
const { actions } = require('./actions');

// Parse command line arguments
const args = process.argv.slice(2);
const agentArg = args.find(arg => arg.startsWith('--agent='));
const selectedAgent = agentArg ? agentArg.split('=')[1] : 'claude';

if (!['codex', 'claude'].includes(selectedAgent)) {
    console.error('Invalid agent. Use --agent=codex or --agent=claude');
    process.exit(1);
}

// Define the model preset for Claude
const modelPreset = {
    model: 'claude-sonnet-4-20250514',
    provider: 'Anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    temperature: 0,
    max_tokens: 8000
};

interface ActionResult {
    actionName: string;
    result: string;
}

/**
 * Handle LLM interaction and action execution (separate from TerminalController)
 */
async function handleTerminalState(screenContent: string, controller: TerminalController, actionResults: ActionResult[] | null): Promise<void> {
    try {
        let contextMessage = `Here is the current terminal screen content:\n\n${screenContent}\n\nWhat do you see? Keep response very brief and concise.`;
        
        // Add action results to context if available
        if (actionResults && actionResults.length > 0) {
            contextMessage += `\n\nResults from previous actions:\n${actionResults.map((result: ActionResult) => 
                `- ${result.actionName}: ${result.result}`
            ).join('\n')}`;
        }

        const result = await promptLLM({
            modelPreset,
            messages: [
                {
                    role: 'user',
                    content: `${contextMessage}

Available actions:
${JSON.stringify(actions, null, 2)}

Please call available functions if appropriate using this format:
[
    {
        name: 'action1',
        parameters: {
            example_param: 'FooBar'
        }
    },
    {
        name: 'action2',
        parameters: {
            example_param: 'BazQux'
        }
    }
]

Respond using the following format:
<thoughts>
Your thoughts about what you see and what to do...
</thoughts>
<actions>
[
    {
        "name": "action1",
        "parameters": {
            "example_param": "FooBar"
        }
    }
]
</actions>`
                }
            ]
        });

        console.log('\nLLM Analysis:');
        console.log('-------------');
        
        let fullResponse = '';
        result.onDelta((chunk: string) => {
            process.stdout.write(chunk);
            fullResponse += chunk;
        });

        const response = await result.response();
        console.log('\n-------------');

        // Parse the response to extract actions
        const actionsMatch = fullResponse.match(/<actions>([\s\S]*?)<\/actions>/);
        if (actionsMatch) {
            try {
                const actionsList = JSON.parse(actionsMatch[1]);
                const currentActionResults: ActionResult[] = [];
                
                for (const action of actionsList) {
                    const actionDef = actions.find((a: any) => a.name === action.name);
                    if (actionDef) {
                        // Execute action using the controller
                        const result = await executeAction(actionDef, action.parameters, controller);
                        
                        // Collect results for potential follow-up
                        if (result !== undefined && result !== null) {
                            currentActionResults.push({
                                actionName: action.name,
                                result: result
                            });
                        }
                    } else {
                        console.log(`Action ${action.name} not found or not available`);
                    }
                }
                
                // If we have action results, trigger another LLM interaction
                if (currentActionResults.length > 0) {
                    console.log('\nAction results collected, continuing with LLM...');
                    const newScreenContent = await controller.getCurrentContent();
                    await handleTerminalState(newScreenContent, controller, currentActionResults);
                }
            } catch (error) {
                console.error('Error parsing actions:', error);
            }
        }
    } catch (error) {
        console.error('Error in LLM interaction:', error);
    }
}

/**
 * Execute an action using the TerminalController instead of raw tmux commands
 */
async function executeAction(actionDef: any, parameters: any, controller: TerminalController): Promise<any> {
    // Create a context object that actions can use
    const context = {
        parameters,
        // Provide the session name that actions expect
        sessionName: controller.getSessionName(),
        // Provide controller methods that actions might need
        sendKeys: controller.sendKeys.bind(controller),
        pressEnter: controller.pressEnter.bind(controller),
        sendCommand: controller.sendCommand.bind(controller),
        runCommand: controller.runCommand.bind(controller),
        getCurrentContent: controller.getCurrentContent.bind(controller)
    };
    
    return await actionDef.handler(context);
}

/**
 * Main function that orchestrates the terminal controller and LLM interaction
 */
async function main(): Promise<void> {
    try {
        console.log(`Starting terminal controller with agent: ${selectedAgent}`);
        
        // Create and initialize the terminal controller
        const controller = new TerminalController({ 
            sessionNamePrefix: selectedAgent
        });

        // Handle errors
        controller.on('error', (error) => {
            console.error('Terminal controller error:', error);
            process.exit(1);
        });

        // Handle session ready - start the agent
        controller.on('ready', async () => {
            try {
                console.log(`Starting ${selectedAgent} in terminal session...`);
                await controller.sendCommand(selectedAgent);
                console.log(`${selectedAgent} started successfully`);
            } catch (error) {
                console.error(`Failed to start ${selectedAgent}:`, error);
                process.exit(1);
            }
        });

        // Log output changes
        controller.on('output', (content) => {
            console.log('\nNew tmux output:');
            console.log('-------------------');
            console.log(content);
            console.log('-------------------');
        });

        // Handle idle state - this is where LLM decisions happen
        controller.on('idle', async () => {
            try {
                const screenContent = await controller.getCurrentContent();
                await handleTerminalState(screenContent, controller, null);
            } catch (error) {
                console.error('Error handling idle state:', error);
            }
        });

        // Keep the process running
        process.on('SIGINT', async () => {
            console.log('\nShutting down...');
            await controller.dispose();
            process.exit(0);
        });

        console.log('Terminal controller initialized. Waiting for session to be ready...');
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Start the main control loop
if (require.main === module) {
    main();
} 