import { Action } from './types';
import { tmuxCommand } from '../utils.ts';

export const typeAction: Action = {
    name: 'type',
    description: 'Type text into the terminal. To submit text, an additional call to `press_key` is required with the key "Enter".',
    input_schema: {
        type: 'object',
        properties: {
            text: { type: 'string' },
        },
        required: ['text'],
    },
    handler: async ({ parameters, sessionName }) => {
        if (!parameters) return;
        
        const text = parameters.text || '';
        await tmuxCommand(`send-keys -l -t ${sessionName} "${text}"`);
        console.log('Typed:', text);
    }
}; 