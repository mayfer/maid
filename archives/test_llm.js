import { promptLLM } from '../llm/chat_api';

// Define the model preset for Claude
const modelPreset = {
    model: 'claude-3-sonnet-20240229',
    provider: 'Anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY, // Make sure to set this in your environment
    temperature: 0.7,
    max_tokens: 1000
};

async function testClaude() {
    try {
        const result = await promptLLM({
            modelPreset,
            messages: [
                {
                    role: 'user',
                    content: 'Hello! Can you tell me a short joke?'
                }
            ]
        });

        // Set up handlers for streaming response
        result.onDelta((delta) => {
            process.stdout.write(delta);
        });

        result.onError((error) => {
            console.error('Error:', error);
        });

        // Get the final response
        const response = await result.response();
        console.log('\n\nFinal response:', response);
    } catch (error) {
        console.error('Error in test:', error);
    }
}

// Run the test
testClaude();
