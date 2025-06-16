import { Action } from './types';
import { tmuxCommand } from '../utils';

export const pressKeyAction: Action = {
    name: 'press_key',
    description: 'Press a specific key in the terminal. Use this for special keys like arrow keys, enter, etc. The key uses tmux key format for `tmux send-keys`, so for example Ctrl+C is "C-c" and Command+C is "M-c".',
    input_schema: {
        type: 'object',
        properties: {
            key: { type: 'string' },
        },
        required: ['key'],
    },
    handler: async ({ parameters, sessionName }) => {
        if (!parameters) return;
        
        const key = parameters.key || '';
        await tmuxCommand(`send-keys -t ${sessionName} ${key}`);
        console.log('Pressed key:', key);
    }
}; 