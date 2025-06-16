import { Action } from './types';
import { tmuxCommand } from '../utils.ts';

export const askAction: Action = {
    name: 'ask',
    description: 'Ask user what to do next.',
    input_schema: {
        type: 'object',
        properties: {
            question: { type: 'string' },
        },
        required: ['question'],
    },
    handler: async ({ parameters, sessionName }) => {
        if (!parameters) return;
        
        // Ask user what to do next
    }
}; 