#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const readline = require('readline');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Utility to execute tmux commands and capture output
function tmuxCommand(command, options = {}) {
  const socketPath = process.env.TMUX_TMPDIR || '/private/tmp/tmux-501';
  const fullCommand = `tmux -S ${socketPath}/default ${command}`;
  console.log(`Executing: ${fullCommand}`);
  try {
    return execSync(fullCommand, { encoding: 'utf8', ...options }).trim();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (error.message.includes('No such file or directory')) {
      console.log('Attempting to start tmux server...');
      try {
        execSync(`tmux -S ${socketPath}/default start-server`, { encoding: 'utf8' });
        return execSync(fullCommand, { encoding: 'utf8', ...options }).trim();
      } catch (startError) {
        console.error(`Failed to start tmux server: ${startError.message}`);
        process.exit(1);
      }
    }
    process.exit(1);
  }
}

// List all tmux sessions
function listSessions() {
  try {
    const output = tmuxCommand('list-sessions');
    const sessions = output.split('\n').map(line => {
      const [name] = line.split(':');
      return name;
    });
    return sessions;
  } catch (error) {
    return [];
  }
}

// Capture pane output for a session
function capturePane(session) {
  try {
    return tmuxCommand(`capture-pane -t ${session} -p`);
  } catch (error) {
    console.error(`Failed to capture pane for session ${session}`);
    return null;
  }
}

// Send input to a session
function sendInput(session, input) {
  try {
    tmuxCommand(`send-keys -t ${session} "${input}" Enter`);
    console.log(`Sent input to ${session}: ${input}`);
  } catch (error) {
    console.error(`Failed to send input to ${session}`);
  }
}

// View session output (snapshot or live)
function viewSession(session, live = false) {
  if (live) {
    // Spawn tmux attach-session in read-only mode
    const tmux = spawn('tmux', ['attach-session', '-r', '-t', session], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    tmux.on('close', (code) => {
      console.log(`Detached from session ${session}`);
      process.exit(code);
    });
  } else {
    // Capture and display pane output
    const output = capturePane(session);
    if (output) {
      console.log(`Output from session ${session}:\n${output}`);
    }
  }
}

// Prompt user to select a session
function promptSession(sessions, callback) {
  console.log('Available sessions:');
  sessions.forEach((session, i) => console.log(`${i + 1}. ${session}`));
  rl.question('Select a session (number or name): ', (answer) => {
    const index = parseInt(answer) - 1;
    const session = index >= 0 && index < sessions.length ? sessions[index] : answer;
    if (sessions.includes(session)) {
      callback(session);
    } else {
      console.error('Invalid session');
      rl.close();
    }
  });
}

// Main CLI logic
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (args.includes('--help')) {
    console.log('Usage:');
    console.log('  test.js list            List all tmux sessions');
    console.log('  test.js view [session] [--live]  View session output (live or snapshot)');
    console.log('  test.js send [session] [input]   Send input to session');
    console.log('  test.js --help          Show this help message');
    rl.close();
    return;
  }

  // Check if tmux server is running
  try {
    tmuxCommand('info');
  } catch (error) {
    console.log('Starting tmux server...');
    try {
      execSync('tmux -S /private/tmp/tmux-501/default start-server', { encoding: 'utf8' });
    } catch (startError) {
      console.error('Failed to start tmux server:', startError.message);
      process.exit(1);
    }
  }

  let sessions = listSessions();
  // Auto-start a session if none exist and command requires a session
  if (sessions.length === 0 && command !== 'list') {
    console.log('No tmux sessions found. Creating a new session: default');
    try {
      tmuxCommand('new-session -d -s default');
      sessions = listSessions(); // Refresh session list
    } catch (error) {
      console.error('Failed to create default session:', error.message);
      process.exit(1);
    }
  }

  if (command === 'list') {
    if (sessions.length === 0) {
      console.log('No active sessions');
    } else {
      console.log('Active sessions:');
      sessions.forEach(session => console.log(`- ${session}`));
    }
    process.exit(0);
  } else if (command === 'view') {
    const session = args[1];
    if (session) {
      if (sessions.includes(session)) {
        viewSession(session, args.includes('--live'));
      } else {
        console.error(`Session ${session} not found`);
      }
    } else {
      promptSession(sessions, (selected) => {
        viewSession(selected, args.includes('--live'));
        rl.close();
      });
    }
  } else if (command === 'send') {
    const session = args[1];
    const input = args[2];
    if (session && input) {
      if (sessions.includes(session)) {
        sendInput(session, input);
      } else {
        console.error(`Session ${session} not found`);
      }
      process.exit(0);
    } else {
      promptSession(sessions, (selected) => {
        rl.question('Enter command to send: ', (input) => {
          sendInput(selected, input);
          rl.close();
        });
      });
    }
  } else {
    console.log('Usage:');
    console.log('  test.js list            List all tmux sessions');
    console.log('  test.js view [session] [--live]  View session output (live or snapshot)');
    console.log('  test.js send [session] [input]   Send input to session');
    console.log('  test.js --help          Show this help message');
    rl.close();
  }
}

main();

// /ok so the point of this program is to use tmux to run a terminal session and pass the current terminal screen contents into an LLM