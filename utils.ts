import { execSync } from 'child_process';

export async function tmuxCommand(command: string, options = {}) {
    try {
        return execSync(`tmux ${command}`, { encoding: 'utf8', ...options }).trim();
    } catch (error) {
        console.error(`Error executing tmux command: ${error.message}`);
        throw error;
    }
} 