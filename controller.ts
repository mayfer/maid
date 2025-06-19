#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
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

// Start tmux server and wait for it to be ready
async function startTmuxServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        const tmux = spawn('tmux', ['start-server']);
        
        tmux.on('error', (error: Error) => {
            console.error('Failed to start tmux server:', error);
            reject(error);
        });

        tmux.on('close', (code: number | null) => {
            if (code === 0) {
                // Give tmux a moment to fully start
                setTimeout(resolve, 1000);
            } else {
                reject(new Error(`tmux server exited with code ${code}`));
            }
        });
    });
}

// Utility to execute tmux commands and capture output
async function tmuxCommand(command: string, options: any = {}): Promise<string> {
    try {
        return execSync(`tmux ${command}`, { encoding: 'utf8', ...options }).trim();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error executing tmux command: ${errorMessage}`);
        throw error;
    }
}

// Capture pane output for a session
async function capturePane(session: string): Promise<string | null> {
    try {
        return await tmuxCommand(`capture-pane -t ${session} -p`);
    } catch (error) {
        console.error(`Failed to capture pane for session ${session}`);
        return null;
    }
}

// Function to detect if terminal is idle (no changes for 2 seconds)
async function isTerminalIdle(session: string, lastContent: string): Promise<boolean> {
    const currentContent = await capturePane(session);
    if (currentContent === lastContent) {
        return true;
    }
    return false;
}

interface ActionResult {
    actionName: string;
    result: string;
}

// Function to handle LLM interaction and user input
async function handleTerminalState(screenContent: string, sessionName: string, actionResults: ActionResult[] | null): Promise<void> {
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
                        const result = await actionDef.handler({
                            parameters: action.parameters,
                            sessionName
                        });
                        
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
                    await handleTerminalState(screenContent, sessionName, currentActionResults);
                }
            } catch (error) {
                console.error('Error parsing actions:', error);
            }
        }
    } catch (error) {
        console.error('Error in LLM interaction:', error);
    }
}

// Function to monitor terminal state changes
async function monitorTerminalState(sessionName: string): Promise<void> {
    let lastContent = '';
    let isIdle = false;
    let lastStateChange = Date.now();

    while (true) {
        const screenContent = await capturePane(sessionName);
        if (!screenContent) {
            console.error('Failed to capture screen content');
            process.exit(1);
        }

        // Handle content changes
        if (screenContent !== lastContent) {
            console.log('\nNew tmux output:');
            console.log('-------------------');
            console.log(screenContent);
            console.log('-------------------');
            lastContent = screenContent;
            isIdle = false;
            lastStateChange = Date.now();
        } else if (!isIdle) {
            // Check if terminal has been idle for 2 seconds
            if (Date.now() - lastStateChange >= 2000) {
                isIdle = true;
                await handleTerminalState(screenContent, sessionName, null);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function main(): Promise<void> {
    try {
        // Start tmux server
        console.log('Starting tmux server...');
        await startTmuxServer();
        console.log('Tmux server started successfully');

        // Create a new session for the selected agent
        const sessionName = `${selectedAgent}-session`;
        try {
            // Check if session exists
            const sessions = await tmuxCommand('list-sessions -F "#{session_name}"');
            if (sessions.includes(sessionName)) {
                await tmuxCommand(`kill-session -t ${sessionName}`);
                console.log(`Killed existing session: ${sessionName}`);
            }
            
            await tmuxCommand(`new-session -d -s ${sessionName}`);
            console.log(`Created new tmux session: ${sessionName}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to create session:', errorMessage);
            process.exit(1);
        }

        // Run the selected agent in the session
        try {
            await tmuxCommand(`send-keys -t ${sessionName} "${selectedAgent}" Enter`);
            console.log(`Started ${selectedAgent} in tmux session`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to start ${selectedAgent}:`, errorMessage);
            process.exit(1);
        }

        // Wait a moment for the agent to start
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Start monitoring terminal state
        await monitorTerminalState(sessionName);

    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main(); 