import { Action } from './types';
import { tmuxCommand } from '../utils.ts';
import * as readline from 'readline';

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
        if (!parameters) return null;
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        return new Promise<string>((resolve) => {
            rl.question(`${parameters.question}\n> `, (answer) => {
                rl.close();
                console.log(`User answered: ${answer}`);
                resolve(answer);
            });
        });
    }
}; 